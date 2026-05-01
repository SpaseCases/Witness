/**
 * witness/src/fetchWithRetry.js
 *
 * Drop-in fetch wrapper that retries on network failure.
 * Used by JournalEntry and RantMode when posting audio/text to the backend.
 *
 * Usage:
 *   import { fetchWithRetry } from './fetchWithRetry'
 *   const res = await fetchWithRetry(url, options)   // same API as fetch()
 */

const RETRY_DELAYS = [2000, 4000, 8000]  // ms between attempts (3 total retries)

export async function fetchWithRetry(url, options = {}) {
  let lastErr
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetch(url, options)
      return res                          // success — return immediately
    } catch (err) {
      lastErr = err
      if (attempt < RETRY_DELAYS.length) {
        console.warn(`[fetch] Attempt ${attempt + 1} failed for ${url} — retrying in ${RETRY_DELAYS[attempt]}ms`)
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
      }
    }
  }
  throw lastErr                           // all attempts exhausted
}
