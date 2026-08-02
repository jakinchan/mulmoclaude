import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rewriteHtmlAssets } from "../../../server/utils/share/rewriteAssets.js";

describe("rewriteHtmlAssets", () => {
  it("rewrites a local img src to assets/ and records the ref", () => {
    const { html, assets } = rewriteHtmlAssets(`<img src="../../images/2026/07/foo.png">`);
    assert.match(html, /src="assets\/foo\.png"/);
    assert.deepEqual(assets, [{ originalRef: "../../images/2026/07/foo.png", bundlePath: "assets/foo.png" }]);
  });

  it("leaves remote, protocol-relative, root-absolute and data URIs untouched", () => {
    const src = `<img src="https://cdn/x.png"><img src="//cdn/y.png"><img src="/z.png"><img src="data:image/png;base64,AAA">`;
    const { html, assets } = rewriteHtmlAssets(src);
    assert.equal(assets.length, 0);
    assert.match(html, /https:\/\/cdn\/x\.png/);
    assert.match(html, /\/\/cdn\/y\.png/);
    assert.match(html, /"\/z\.png"/);
    assert.match(html, /data:image\/png/);
  });

  it("rewrites link[href], script[src], video[poster]", () => {
    const { assets } = rewriteHtmlAssets(`<link rel="stylesheet" href="style.css"><script src="app.js"></script><video poster="p.jpg"></video>`);
    assert.deepEqual(assets.map((asset) => asset.bundlePath).sort(), ["assets/app.js", "assets/p.jpg", "assets/style.css"]);
  });

  it("does NOT rewrite a[href] (navigation, not an asset)", () => {
    const { html, assets } = rewriteHtmlAssets(`<a href="other.html">x</a>`);
    assert.equal(assets.length, 0);
    assert.match(html, /href="other\.html"/);
  });

  it("rewrites each url in srcset, keeping descriptors", () => {
    const { html, assets } = rewriteHtmlAssets(`<img srcset="a.png 1x, b.png 2x">`);
    assert.match(html, /srcset="assets\/a\.png 1x, assets\/b\.png 2x"/);
    assert.equal(assets.length, 2);
  });

  it("does not split a data: URI inside srcset (commas in payload)", () => {
    const { html, assets } = rewriteHtmlAssets(`<img srcset="data:image/png;base64,AAA 1x">`);
    assert.equal(assets.length, 0);
    assert.match(html, /srcset="data:image\/png;base64,AAA 1x"/);
  });

  it("rewrites only the local candidate in a mixed data:/local srcset", () => {
    const { html, assets } = rewriteHtmlAssets(`<img srcset="data:image/png;base64,AAA 1x, foo.png 2x">`);
    assert.deepEqual(assets, [{ originalRef: "foo.png", bundlePath: "assets/foo.png" }]);
    assert.match(html, /srcset="data:image\/png;base64,AAA 1x, assets\/foo\.png 2x"/);
  });

  it("rewrites url() in <style> and inline style", () => {
    const { html, assets } = rewriteHtmlAssets(`<style>.a{background:url('bg.png')}</style><div style="background:url(d.png)"></div>`);
    assert.match(html, /url\('assets\/bg\.png'\)/);
    assert.match(html, /url\(assets\/d\.png\)/);
    assert.equal(assets.length, 2);
  });

  it("dedups the same ref to one asset with a stable bundlePath", () => {
    const { assets } = rewriteHtmlAssets(`<img src="foo.png"><img src="foo.png">`);
    assert.deepEqual(assets, [{ originalRef: "foo.png", bundlePath: "assets/foo.png" }]);
  });

  it("disambiguates a basename collision from different dirs", () => {
    const { assets } = rewriteHtmlAssets(`<img src="a/logo.png"><img src="b/logo.png">`);
    assert.equal(assets.length, 2);
    const paths = assets.map((asset) => asset.bundlePath);
    assert.equal(new Set(paths).size, 2, "collided basenames must get distinct bundle paths");
    assert.ok(paths.includes("assets/logo.png"));
  });

  it("strips query/hash when deriving the bundle filename", () => {
    const { assets } = rewriteHtmlAssets(`<img src="foo.png?v=2">`);
    const [asset] = assets;
    assert.ok(asset);
    assert.equal(asset.bundlePath, "assets/foo.png");
  });

  it("preserves a #fragment on the rewritten url (svg sprite)", () => {
    const { html, assets } = rewriteHtmlAssets(`<svg><use href="sprite.svg#icon"></use></svg>`);
    const [asset] = assets;
    assert.ok(asset);
    assert.equal(asset.bundlePath, "assets/sprite.svg");
    assert.match(html, /href="assets\/sprite\.svg#icon"/);
  });

  it("preserves ?query on the url and dedups the underlying file", () => {
    const { html, assets } = rewriteHtmlAssets(`<img src="a.png?v=1"><img src="a.png?v=2">`);
    assert.equal(assets.length, 1);
    const [asset] = assets;
    assert.ok(asset);
    assert.equal(asset.bundlePath, "assets/a.png");
    assert.match(html, /src="assets\/a\.png\?v=1"/);
    assert.match(html, /src="assets\/a\.png\?v=2"/);
  });

  it("sanitizes a backslash-containing ref to a safe bundle name (zip-slip)", () => {
    const { html, assets } = rewriteHtmlAssets(`<img src="..\\..\\evil.png">`);
    assert.equal(assets.length, 1);
    const [asset] = assets;
    assert.ok(asset);
    assert.equal(asset.bundlePath, "assets/evil.png");
    assert.doesNotMatch(html, /\.\.[\\/]/);
  });

  it("collapses an all-traversal ref to a neutral name", () => {
    const { assets } = rewriteHtmlAssets(`<img src="../../..">`);
    const [asset] = assets;
    assert.ok(asset);
    assert.equal(asset.bundlePath, "assets/asset");
  });
});
