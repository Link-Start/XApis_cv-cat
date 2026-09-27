// 运行 X 登录流下发的 js_inst 挑战脚本，取回它写进 ui_metrics 输入框的值。
//
// 脚本每次下发都会随机重命名 + 随机变形，但宿主依赖是固定的一小撮：
// 它会 createElement 建一棵 div 树、按位写 innerText、再沿 parentNode 回溯累加，
// 也就是说**结果真的取决于 DOM 树的结构**，给个空壳桩会算错（而且服务端是延后校验的，
// 提交 JS 那步照样返回 success，到下一步才报 399）。
//
// 所以这里实现一个「够用但真实」的最小 DOM：
//   createElement / setAttribute / appendChild / removeChild
//   children / lastElementChild / parentNode / innerText
// 这几个是实抓脚本用到的全部成员，语义与浏览器一致。
//
// 用法：node static/ui_metrics.js <js_inst脚本路径>

const fs = require('fs');

const noop = () => {};

class Element {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.innerText = '';
  }

  get lastElementChild() {
    return this.children.length ? this.children[this.children.length - 1] : null;
  }

  get firstElementChild() {
    return this.children.length ? this.children[0] : null;
  }

  get childNodes() {
    return this.children;
  }

  get parentElement() {
    return this.parentNode;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) {
      this.children.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  addEventListener() {}

  removeEventListener() {}
}

// 挑战脚本把结果写进 name=ui_metrics 的输入框，这里用它当出口
let captured = null;
const sink = new Element('input');
Object.defineProperty(sink, 'value', {
  get: () => captured,
  set: (v) => {
    captured = v;
  },
});

const html = new Element('html');
const body = new Element('body');
const head = new Element('head');
html.appendChild(head);
html.appendChild(body);

const documentStub = {
  readyState: 'complete',
  cookie: '',
  referrer: '',
  title: 'X',
  URL: 'https://x.com/',
  documentElement: html,
  head,
  body,
  createElement: (tag) => new Element(tag),
  createTextNode: () => new Element('#text'),
  getElementsByName: (name) => (name === 'ui_metrics' ? [sink] : []),
  getElementsByTagName: (tag) => {
    const key = String(tag || '').toLowerCase();
    if (key === 'body') return [body];
    if (key === 'head') return [head];
    if (key === 'html') return [html];
    return [];
  },
  getElementsByClassName: () => [],
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
};

globalThis.document = documentStub;
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.screen = {
  width: 1920, height: 1080, availWidth: 1920, availHeight: 1040,
  colorDepth: 24, pixelDepth: 24,
};
globalThis.location = {
  href: 'https://x.com/', hostname: 'x.com', protocol: 'https:',
  pathname: '/', search: '', host: 'x.com', origin: 'https://x.com',
};
globalThis.navigator = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  platform: 'Win32',
  language: 'en-US',
  languages: ['en-US', 'en'],
  hardwareConcurrency: 12,
  plugins: [],
  mimeTypes: [],
  cookieEnabled: true,
  webdriver: false,
};
globalThis.history = { length: 1 };

// 挑战脚本用 setTimeout 延后执行，这里同步跑掉，省去等待
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => {
  if (typeof fn === 'function' && (!ms || ms <= 0)) {
    fn();
    return 0;
  }
  return realSetTimeout(fn, ms);
};

try {
  (0, eval)(fs.readFileSync(process.argv[2], 'utf8'));
} catch (err) {
  process.stderr.write(`ui_metrics 执行失败: ${err && err.stack}\n`);
  process.exit(1);
}

if (!captured) {
  process.stderr.write('ui_metrics 脚本没有写出结果\n');
  process.exit(2);
}
if (captured.startsWith('exception ')) {
  // 脚本内部自己 try/catch 掉了，把异常原样抛出来，避免拿错误串去登录
  process.stderr.write(`${captured}\n`);
  process.exit(3);
}
process.stdout.write(captured);
