import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
globalThis.customElements = new JSDOM('').window.customElements;
const { EscImages } = await import('../src/code/escImages.js');
const C = await import('../src/code/constants.js');

for (const scenario of ['original', 'fallback', 'both fail']) {
  test(`image loading completes when ${scenario}`, async (t) => {
    class TestImage {
      width = 153;
      height = 250;
      set src(value) {
        const success = scenario === 'original' ||
          (scenario === 'fallback' && !value.includes('missing.png'));
        queueMicrotask(() => success ? this.onload() : this.onerror());
      }
    }
    t.mock.method(console, 'warn', () => {});
    const previous = globalThis.Image;
    globalThis.Image = TestImage;
    t.after(() => { globalThis.Image = previous; });
    const images = new EscImages([{
      id: () => 'test', imageMap: () => '/custom',
      getImage: type => type === C.CONFIG_WINDOW_IMAGE ? 'missing.png' : '',
    }]);
    let timer;
    const completed = await Promise.race([
      images.processImages().then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 100); }),
    ]);
    clearTimeout(timer);
    assert.equal(completed, true, 'failed images must not hang card initialization');
    assert.equal(images.getWindowImageSize('test').x(), scenario === 'both fail' ? 0 : 153);
    assert.equal(images.getWindowImageSrc('test'), scenario === 'original'
      ? '/custom/missing.png' : `${C.ESC_IMAGE_MAP}/${C.CONFIG_DEFAULT[C.CONFIG_WINDOW_IMAGE]}`);
  });
}
