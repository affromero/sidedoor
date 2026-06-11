import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Behavioral test for the sourceable shell menu. It runs the real bash function
// with piped input and asserts what reaches SIDEDOOR_REACH_URL, because the
// security contract is "the default exposes nothing".
const script = fileURLToPath(new URL('../install/reach-menu.sh', import.meta.url));

function runMenu(input: string, port = '3000', app = 'My App'): { url: string; out: string } {
  const cmd =
    `source ${JSON.stringify(script)}; ` +
    `sidedoor_reach_menu ${port} ${JSON.stringify(app)} <<< ${JSON.stringify(input)}; ` +
    `printf 'URL=%s\\n' "$SIDEDOOR_REACH_URL"`;
  const out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });
  const match = out.match(/^URL=(.*)$/m);
  return { url: match ? match[1]!.trim() : '', out };
}

describe('sidedoor_reach_menu', () => {
  it('exposes nothing by default when the user just presses enter', () => {
    const { url, out } = runMenu('');
    expect(url).toBe('');
    expect(out).toMatch(/nothing is exposed|keeping it private/i);
  });

  it('exposes nothing for the explicit private choice', () => {
    expect(runMenu('1').url).toBe('');
  });

  it('does not auto expose for Tailscale; it only prints guidance', () => {
    const { url, out } = runMenu('3');
    expect(url).toBe('');
    expect(out).toMatch(/tailscale serve 3000/i);
  });

  it('clearly warns that the public choice exposes the app to the internet', () => {
    const { url, out } = runMenu('4');
    expect(url).toBe('');
    expect(out).toMatch(/public internet/i);
  });

  it('only ever yields an http LAN url for the network choice, never https', () => {
    const { url } = runMenu('2');
    // Either no LAN IP was determinable (empty) or a plain http url on the port.
    expect(url === '' || /^http:\/\/[0-9.]+:3000$/.test(url)).toBe(true);
    expect(url.startsWith('https://')).toBe(false);
  });
});
