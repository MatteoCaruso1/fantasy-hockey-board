// Read the Windows clipboard, so a prompt can take "copy it, then press Enter"
// instead of a paste (Ctrl+V does not paste in every Command Prompt window).
import { execFileSync } from 'node:child_process';

export const readClipboard = () => {
  try { return execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};

// Ask until `ok(value)` passes; an empty Enter uses whatever is on the clipboard
export async function askOrClip(rl, prompt, ok, retry) {
  for (;;) {
    const typed = (await rl.question(prompt)).trim();
    const v = typed || readClipboard();
    if (ok(v)) return v;
    console.log(retry);
  }
}
