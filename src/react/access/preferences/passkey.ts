function key(endpoint = '/api/access'): string {
  let end = endpoint.length;
  while (end > 0 && endpoint[end - 1] === '/') end -= 1;
  return `sidedoor:passkey-saved:${endpoint.slice(0, end)}`;
}

/** A browser preference only. Admission always requires a server-verified session. */
export function hasSavedPasskey(endpoint?: string): boolean {
  try {
    return window.localStorage.getItem(key(endpoint)) === 'true';
  } catch {
    return false;
  }
}

export function rememberPasskey(endpoint?: string, saved = true): void {
  try {
    if (saved) window.localStorage.setItem(key(endpoint), 'true');
    else window.localStorage.removeItem(key(endpoint));
  } catch {
    // Storage is optional. Private browsing must still allow admission.
  }
}
