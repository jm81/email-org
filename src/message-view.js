// Renders a parsed message as a standalone HTML page (the "Open full
// message" tab). Headers and attachment list on top; the message body lives
// in a sandboxed srcdoc iframe so its markup can't run scripts or touch the
// app — links still work and open in a new tab via <base target>. cid:
// references are resolved to data: URIs so inline images render. The route
// sets a CSP that blocks everything except images/styles/fonts.

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineCids(html, attachments) {
  let out = html;
  for (const a of attachments) {
    if (!a.contentId || !a.content) continue;
    const cid = a.contentId.replace(/^<|>$/g, '');
    out = out.replaceAll(`cid:${cid}`, `data:${a.contentType};base64,${a.content.toString('base64')}`);
  }
  return out;
}

function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function renderMessageView(parsed, row) {
  const subject = parsed.subject ?? row.subject ?? '(no subject)';
  const attachments = parsed.attachments ?? [];

  const bodyDoc = parsed.html
    ? inlineCids(parsed.html, attachments)
    : `<div style="font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.5; padding: 4px">
         ${parsed.textAsHtml ?? '<p>(no content)</p>'}
       </div>`;

  const hdr = (label, value) =>
    value ? `<div class="h"><span class="k">${label}</span><span class="v">${esc(value)}</span></div>` : '';

  // Real attachments only — inline images already render in the body. The
  // link index is the position in parsed.attachments, matching the
  // /:id/attachment/:index route.
  const attList = attachments
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.contentDisposition !== 'inline' || !a.contentId)
    .map(({ a, i }) =>
      `<a class="att" href="/api/messages/${row.id}/attachment/${i}" download>📎 ${esc(a.filename || '(unnamed)')} <span class="dim">${fmtSize(a.size)}</span></a>`)
    .join('');

  const rawHeaders = (parsed.headerLines ?? []).map((h) => h.line).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(subject)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column;
         font-family: system-ui, sans-serif; font-size: 13px; }
  header { padding: 12px 16px 8px; border-bottom: 1px solid #ccc; background: #f6f6f6; color: #222; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  .h { margin: 2px 0; }
  .k { display: inline-block; width: 44px; color: #777; }
  .v { color: #222; }
  .atts { margin-top: 6px; }
  .att { margin-right: 14px; color: #1a56b0; text-decoration: none; }
  .att:hover { text-decoration: underline; }
  .dim { color: #777; }
  details { margin-top: 8px; color: #777; }
  details pre { max-height: 240px; overflow: auto; background: #fff; color: #222;
                padding: 8px; border: 1px solid #ddd; font-size: 11px; margin: 4px 0 0; }
  iframe { flex: 1; border: 0; width: 100%; background: #fff; }
</style>
</head>
<body>
<header>
  <h1>${esc(subject)}</h1>
  ${hdr('From', parsed.from?.text)}
  ${hdr('To', parsed.to?.text)}
  ${hdr('Cc', parsed.cc?.text)}
  ${hdr('Date', parsed.date ? parsed.date.toUTCString() : row.date)}
  ${attList ? `<div class="atts">${attList}</div>` : ''}
  <details><summary>All headers</summary><pre>${esc(rawHeaders)}</pre></details>
</header>
<iframe sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcdoc="${esc(`<base target="_blank">${bodyDoc}`)}"></iframe>
</body>
</html>`;
}
