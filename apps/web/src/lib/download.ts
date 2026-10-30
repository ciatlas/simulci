/**
 * Offers text as a file the browser saves: a Blob behind an object URL on a clicked `<a download>`, revoked once the
 * click has handed it over. Nothing leaves the page (a download is not a fetch: `connect-src` has no say).
 */
export function downloadText(
  name: string,
  text: string,
  type: string,
  doc: Document = document,
  later: (fn: () => void) => void = (fn) => setTimeout(fn, 0),
): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  doc.body.append(a);
  a.click();
  a.remove();
  later(() => URL.revokeObjectURL(url));
}
