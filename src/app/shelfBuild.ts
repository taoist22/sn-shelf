// Build number for the JS half of Shelf, shown on the Insert Page screen and written to
// EXPORT/shelf-log.txt next to ShelfPdfEditModule.NATIVE_BUILD.
//
// Bump BOTH on every test build and keep them equal. Without this the native half could be
// proven current from a log while the bundle could not, which cost a round of guessing when
// a size control "wasn't there" (2026-10-30).
export const JS_BUILD = 22;
