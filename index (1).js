const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// المفتاح يتخزن كـ "Secret" فـ Firebase، ما يبانش أبدًا فـ الكود ولا فـ الموقع
const GOOGLE_PLACES_API_KEY = defineSecret("GOOGLE_PLACES_API_KEY");

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 أيام

/**
 * Callable Function: searchPharmacies
 * يستقبل { wilaya, commune } من التطبيق، ويرجع قائمة الصيدليات
 * (من الكاش إذا كان حديث، أو يطلب من Google ويخزن النتيجة فـ الكاش)
 */
exports.searchPharmacies = onCall(
  { secrets: [GOOGLE_PLACES_API_KEY], region: "us-central1" },
  async (request) => {
    const wilayaName = (request.data && request.data.wilaya || "").trim();
    const communeName = (request.data && request.data.commune || "").trim();

    if (!wilayaName || !communeName) {
      throw new HttpsError("invalid-argument", "wilaya و commune مطلوبين.");
    }

    const cacheKey = (wilayaName + "__" + communeName).replace(/[\/\s]/g, "_");
    const cacheRef = db.collection("places_cache").doc(cacheKey);

    // 1) نشوف الكاش أول
    try {
      const snap = await cacheRef.get();
      if (snap.exists) {
        const data = snap.data();
        const fetchedAtMs = data.fetchedAt && data.fetchedAt.toMillis ? data.fetchedAt.toMillis() : 0;
        const age = Date.now() - fetchedAtMs;
        if (age < CACHE_TTL_MS && Array.isArray(data.rows)) {
          return { rows: data.rows, cached: true };
        }
      }
    } catch (e) {
      // إذا فشل قراءة الكاش، نكمل ونطلب من Google
    }

    // 2) نطلب من Google Places API (Text Search - New)
    const query = "صيدلية في " + communeName + "، " + wilayaName + "، الجزائر";
    let places = [];
    try {
      const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY.value(),
          "X-Goog-FieldMask": [
            "places.id", "places.displayName", "places.formattedAddress", "places.location",
            "places.nationalPhoneNumber", "places.internationalPhoneNumber",
            "places.currentOpeningHours", "places.regularOpeningHours",
          ].join(","),
        },
        body: JSON.stringify({
          textQuery: query,
          languageCode: "ar",
          regionCode: "DZ",
          maxResultCount: 20,
        }),
      });
      if (!res.ok) {
        throw new Error("places_error_" + res.status);
      }
      const data = await res.json();
      places = Array.isArray(data.places) ? data.places : [];
    } catch (e) {
      throw new HttpsError("unavailable", "تعذر الاتصال بـ Google Places API.");
    }

    const rows = places.map((p) => placeToPharmacy(p, wilayaName, communeName));

    // 3) نخزن فـ الكاش
    try {
      await cacheRef.set({ rows, fetchedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (e) {}

    return { rows, cached: false };
  }
);

function extractHoursFromPlace(place) {
  const oh = place.currentOpeningHours || place.regularOpeningHours;
  if (oh && Array.isArray(oh.periods) && oh.periods.length) {
    const todayIdx = new Date().getDay();
    const todayPeriod = oh.periods.find((p) => p.open && p.open.day === todayIdx);
    if (todayPeriod && todayPeriod.open && todayPeriod.close) {
      const open = todayPeriod.open.hour + (todayPeriod.open.minute || 0) / 60;
      let close = todayPeriod.close.hour + (todayPeriod.close.minute || 0) / 60;
      if (todayPeriod.close.day !== todayPeriod.open.day) close += 24;
      return { open, close };
    }
  }
  return { open: 8, close: 21 };
}

function placeToPharmacy(place, wilayaName, communeName) {
  const oh = place.currentOpeningHours || place.regularOpeningHours;
  return {
    id: place.id,
    name: (place.displayName && place.displayName.text) || "صيدلية",
    area: communeName,
    address: place.formattedAddress || "",
    phone: place.nationalPhoneNumber || place.internationalPhoneNumber || null,
    lat: place.location ? place.location.latitude : null,
    lng: place.location ? place.location.longitude : null,
    hours: extractHoursFromPlace(place),
    onDuty: false,
    complaints: 0,
    ratingSum: 0,
    ratingCount: 0,
    wilaya: wilayaName,
    verified: true,
    source: "google",
    liveOpenNow: oh && typeof oh.openNow === "boolean" ? oh.openNow : null,
  };
}
