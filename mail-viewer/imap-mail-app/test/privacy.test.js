const assert = require('node:assert/strict');
const test = require('node:test');
const { prepareHtmlForRender } = require('../sanitize');

for (const source of ['https://tracker.test/pixel', '//tracker.test/pixel', 'http://127.0.0.1/pixel']) {
  test('remote image stays inert: ' + source, () => {
    const html = prepareHtmlForRender('<img src="' + source + '" srcset="https://tracker.test/other 2x" onload="alert(1)">');
    assert.match(html, /data-remote-src=/);
    assert.doesNotMatch(html, /<img src=|srcset=|onload=/);
  });
}

for (const source of ['/api/image-proxy?url=https://tracker.test/pixel', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'file:///secret']) {
  test('unsafe image source removed: ' + source, () => {
    assert.ok(!prepareHtmlForRender('<img src="' + source + '">').includes(source));
  });
}

test('embedded raster image preserved', () => {
  const source = 'data:image/png;base64,aGVsbG8=';
  assert.ok(prepareHtmlForRender('<img src="' + source + '">').includes(source));
});

test('CSS resource syntax and sender-forged consent are stripped', () => {
  const html = prepareHtmlForRender('<p style="background:image-set(url(https://tracker.test/p) 1x);color:red">ok</p><img data-remote-src="https://tracker.test/forged">');
  assert.doesNotMatch(html, /tracker.test|image-set|data-remote-src/);
  assert.match(html, /color:red/);
});
