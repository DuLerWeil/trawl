import { describe, expect, test } from "bun:test"
import { browserDocumentHtml } from "../src/utils/response"

const viewerShell = (text: string) =>
  `<html><head><link rel="stylesheet" href="resource://content-accessible/plaintext.css"></head>` +
  `<body><pre>${text}</pre></body></html>`

describe("browserDocumentHtml", () => {
  test("keeps the rendered DOM for HTML documents", () => {
    expect(browserDocumentHtml("text/html; charset=utf-8", "<html><body>ok</body></html>")).toBe(
      "<html><body>ok</body></html>",
    )
  })

  test("returns charset-less UTF-8 HTML fragments without serializing the DOM", () => {
    const raw = '  <div data-ct="第1話">中文内容</div>\n'
    const rendered = '<html><head></head><body><div data-ct="ç¬¬1è©±">ä¸­æ–‡å†…å®¹</div></body></html>'
    expect(browserDocumentHtml("text/html", rendered, Buffer.from(raw))).toBe(raw)
  })

  test("keeps the rendered DOM for complete HTML documents", () => {
    const raw = "<html><body>第1話</body></html>"
    const rendered = "<html><body>rendered</body></html>"
    expect(browserDocumentHtml("text/html", rendered, Buffer.from(raw))).toBe(rendered)
  })

  test("keeps the rendered DOM for non-UTF-8 fragments without a declared charset", () => {
    const raw = Buffer.concat([Buffer.from("<div>caf"), Buffer.from([0xe9]), Buffer.from("</div>")])
    const rendered = "<html><body><div>café</div></body></html>"
    expect(browserDocumentHtml("text/html", rendered, raw)).toBe(rendered)
  })

  test("keeps the rendered DOM for HTML fragments with a declared charset", () => {
    const raw = "<div>第1話</div>"
    const rendered = "<html><body><div>第1話</div></body></html>"
    expect(browserDocumentHtml("text/html; charset=utf-8", rendered, Buffer.from(raw))).toBe(rendered)
  })

  test.each([
    '<meta charset="utf-8"><div>第1話</div>',
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><div>第1話</div>',
  ])("keeps the rendered DOM for fragments with an in-body charset declaration", (raw) => {
    const rendered = "<html><body>rendered</body></html>"
    expect(browserDocumentHtml("text/html", rendered, Buffer.from(raw))).toBe(rendered)
  })

  test("ignores charset text inside a quoted MIME parameter", () => {
    const raw = "<div>第1話</div>"
    const rendered = "<html><body>rendered</body></html>"
    expect(browserDocumentHtml('text/html; profile="example;charset=legacy"', rendered, Buffer.from(raw))).toBe(raw)
  })

  test("keeps the rendered DOM for ASCII HTML fragments", () => {
    const rendered = "<html><body><div>ok</div></body></html>"
    expect(browserDocumentHtml("text/html", rendered, Buffer.from("<div>ok</div>"))).toBe(rendered)
  })

  test("keeps the rendered DOM when no content type was captured", () => {
    expect(browserDocumentHtml(undefined, viewerShell("unknown type"))).toBe(viewerShell("unknown type"))
  })

  test("returns the raw document for plain text instead of the browser viewer shell", () => {
    const raw = '{"compilerOptions":{"target":"ESNext"}}'
    expect(browserDocumentHtml("text/plain; charset=utf-8", viewerShell(raw), Buffer.from(raw))).toBe(raw)
  })

  test("returns the raw document for JSON content types", () => {
    const raw = '{"ok":[1,2,3]}'
    expect(browserDocumentHtml("application/json", viewerShell(raw), Buffer.from(raw))).toBe(raw)
  })

  test("returns the raw document for XML content types", () => {
    const raw = '<?xml version="1.0"?><rss><item>ok</item></rss>'
    expect(browserDocumentHtml("application/xml", viewerShell(raw), Buffer.from(raw))).toBe(raw)
  })

  test("treats xhtml as the rendered DOM", () => {
    const xhtml = '<html xmlns="http://www.w3.org/1999/xhtml"><body>ok</body></html>'
    expect(browserDocumentHtml("application/xhtml+xml", xhtml)).toBe(xhtml)
  })

  test("falls back to the rendered DOM when no body was captured", () => {
    expect(browserDocumentHtml("text/plain", viewerShell("shell only"))).toBe(viewerShell("shell only"))
  })

  test("preserves whitespace in non-HTML text", () => {
    const raw = "  alpha\r\n\r\n\r\nbeta  \n"
    expect(browserDocumentHtml("text/plain; charset=utf-8", viewerShell(raw), Buffer.from(raw))).toBe(raw)
  })

  test("returns an empty captured text document instead of the viewer", () => {
    expect(browserDocumentHtml("text/plain", viewerShell(""), new Uint8Array())).toBe("")
  })

  test.each(["iso-8859-1", '"windows-1252"', "'windows-1252'"])("decodes the declared charset %s", (charset) => {
    expect(
      browserDocumentHtml(`text/plain; charset=${charset}`, viewerShell("café"), Buffer.from([99, 97, 102, 233])),
    ).toBe("café")
  })

  test("decodes UTF-16 text without changing whitespace", () => {
    const raw = "  café\r\n"
    expect(browserDocumentHtml("text/plain; charset=utf-16le", viewerShell(raw), Buffer.from(raw, "utf16le"))).toBe(raw)
  })

  test("falls back to UTF-8 for an unsupported charset", () => {
    expect(browserDocumentHtml("text/plain; charset=unknown", viewerShell("café"), Buffer.from("café"))).toBe("café")
  })

  test("returns nothing for binary content", () => {
    expect(browserDocumentHtml("image/png", viewerShell("binary"), Buffer.from([1, 2, 3]))).toBe("")
  })
})
