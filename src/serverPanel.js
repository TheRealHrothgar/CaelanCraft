// Caelancraft — the title screen's "Play together" panel (docs/DESIGN-multiplayer.md §2): shown when the page was served
// by a game server (or ?server= names one). The player's name (kept in the browser) and a Join button; a status line
// says what is happening (connecting, refused, the connection lost).

/** The browser's key for the name a player last joined with. */
export const NAME_KEY = 'caelancraft:v2:mp-name';

/**
 * @param {Document} doc
 * @param {{ onJoin: (name: string) => void, storage?: Storage|null }} hooks
 */
export function createServerPanel(doc, hooks) {
  const panel = doc.getElementById('server-panel');
  const infoEl = doc.getElementById('server-info');
  const nameInput = /** @type {HTMLInputElement|null} */ (doc.getElementById('server-name'));
  const joinBtn = /** @type {HTMLButtonElement|null} */ (doc.getElementById('btn-join'));
  const msgEl = doc.getElementById('server-message');
  const storage = hooks.storage ?? null;
  let busy = false;

  try {
    const saved = storage && storage.getItem(NAME_KEY);
    if (saved && nameInput) nameInput.value = saved;
  } catch {
    // no storage: an empty name (the server names the player after their avatar)
  }

  const join = () => {
    if (busy || !panel || panel.hidden) return;
    const name = nameInput ? nameInput.value.trim() : '';
    try {
      if (storage) storage.setItem(NAME_KEY, name);
    } catch {
      // private mode
    }
    hooks.onJoin(name);
  };
  if (joinBtn) joinBtn.addEventListener('click', join);
  if (nameInput) {
    nameInput.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        join();
      }
    });
  }

  /** @param {string} text @param {boolean} [isError] */
  function setMessage(text, isError = false) {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.classList.toggle('error', Boolean(isError));
  }

  return {
    /**
     * Show the panel for a server.
     * @param {{ name: string, players: number, mode: string, mismatch?: boolean }} info
     */
    show(info) {
      if (!panel) return;
      panel.hidden = false;
      if (infoEl) {
        const who = info.players === 0 ? 'nobody playing yet' : `${info.players} playing`;
        infoEl.textContent = `“${info.name}” · ${info.mode === 'survival' ? 'Survival' : 'Creative'} · ${who}`;
      }
      if (info.mismatch) setMessage('This server runs another version of the game: reload the page.', true);
    },
    hide() {
      if (panel) panel.hidden = true;
    },
    /** @returns {boolean} the panel is shown */
    get shown() {
      return Boolean(panel) && !panel.hidden;
    },
    setMessage,
    /** While joining: the button is off. @param {boolean} b */
    setBusy(b) {
      busy = Boolean(b);
      if (joinBtn) joinBtn.disabled = busy;
    },
  };
}
