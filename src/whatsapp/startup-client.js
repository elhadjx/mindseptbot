const { Client } = require('whatsapp-web.js');

const MAX_INJECTION_ATTEMPTS = 3;
const CONTEXT_WAIT_TIMEOUT_MS = 30000;

function isNavigationError(error) {
  const message = error?.message || String(error);
  return /Execution context was destroyed|Cannot find context with specified id/i.test(message);
}

/**
 * whatsapp-web.js 1.34.7 registers its navigation listener only AFTER the first
 * inject() succeeds. A reload while inject() waits for the authentication state
 * therefore rejects initialize() with no way to resume on the new document.
 *
 * Retry that first injection on the same page. Rebuilding the whole Client
 * restores the Mongo archive again and can replay the same startup failure.
 * Keep this override limited to startup; later navigation stays with upstream.
 */
class StartupClient extends Client {
  #starting = false;
  #injectionPromise = null;
  #startupAbort = new AbortController();

  async initialize() {
    this.#startupAbort.signal.throwIfAborted();
    this.#starting = true;
    try {
      return await super.initialize();
    } finally {
      this.#starting = false;
    }
  }

  inject() {
    if (!this.#starting) return super.inject();
    if (!this.#injectionPromise) {
      this.#injectionPromise = this.#injectDuringStartup().finally(() => {
        this.#injectionPromise = null;
      });
    }
    return this.#injectionPromise;
  }

  async #injectDuringStartup() {
    const page = this.pupPage;
    const signal = this.#startupAbort.signal;
    for (let attempt = 1; attempt <= MAX_INJECTION_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await super.inject();
      } catch (error) {
        signal.throwIfAborted();
        if (
          !isNavigationError(error) ||
          attempt === MAX_INJECTION_ATTEMPTS ||
          page !== this.pupPage ||
          page.isClosed() ||
          !this.pupBrowser?.isConnected()
        ) {
          throw error;
        }
        console.warn(
          `[wa] startup injection interrupted by navigation; ` +
          `retrying on the same page (attempt ${attempt + 1}/${MAX_INJECTION_ATTEMPTS})`
        );
        // Puppeteer's waitForFunction reruns on the new document if another
        // navigation occurs. A plain evaluate() or fixed sleep cannot do that.
        const handle = await page.waitForFunction(
          () => window.Debug?.VERSION !== undefined && typeof window.require === 'function',
          { polling: 200, timeout: CONTEXT_WAIT_TIMEOUT_MS, signal }
        );
        await handle.dispose();
      }
    }
  }

  cancelStartup() {
    this.#startupAbort.abort(new Error('WhatsApp startup cancelled'));
  }

  async destroy() {
    this.cancelStartup();
    return super.destroy();
  }
}

module.exports = { StartupClient };
