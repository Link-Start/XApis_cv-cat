/**
 * Castle SDK 补环境加载器。
 * 目标：Node 里 require 模块 321128 → configure({pk}) → createRequestToken()。
 * 每轮按诊断报告只改本文件（env_core.js / castle.js 不动）。
 *
 * 生产默认**安静**：stdout 只输出一行 `__CASTLE_TOKEN__=<token>`（Python 侧靠它取值），
 * 失败信息走 stderr。设 `CASTLE_DEBUG=1` 才恢复全量补环境诊断（模块/SDK 探针、WORKER DIAG、
 * env 报告与 worker 诊断），逆向或补丁重推时用。
 *
 * 环境保真度不是靠猜的：`_sig.js` + `_sigdiff.js` 会把这里采到的 109 路信号与浏览器实抓基线
 * （`_bsig.json`）逐路对拍，`_win.js` / `_fb.js` 报缺失全局与被兜底打死的采集器。
 * 改本文件后请跑一遍，别让某路信号悄悄消失。
 */
const nodeCrypto = require('crypto');
const _fs = require('fs');
const _path = require('path');
const _dirname = __dirname; // init() 会隐藏 __dirname
const _RealPromise = Promise;
const _promiseLog = new Map();
const _promiseMeta = new WeakMap();
let _pid = 0;
let _pidAtToken = -1;
class TP extends _RealPromise {
  constructor(executor) {
    const id = ++_pid;
    const stack = new Error().stack || '';
    super((resolve, reject) => {
      executor(
        (v) => { const e = _promiseLog.get(id); if (e) e.settled = 'resolve'; resolve(v); },
        (e) => { const x = _promiseLog.get(id); if (x) x.settled = 'reject'; reject(e); }
      );
    });
    _promiseLog.set(id, { stack, settled: null });
    try { _promiseMeta.set(this, { id, stack }); } catch (e) {}
  }
  static all(iter) {
    let arr;
    try { arr = Array.from(iter); } catch (e) { return super.all(iter); }
    TP._allCalls.push(arr);
    return super.all(arr);
  }
}
TP._allCalls = [];
const _Buffer = Buffer; // init() 会隐藏 Buffer，提前留引用
const _hrtimeBig = process.hrtime.bigint.bind(process.hrtime); // init() 会隐藏 process
const _PERF_MARKS = String(process.env.CASTLE_PERFORMANCE_MARKS || 'scripts-deferred-start')
  .split(',').map((x) => x.trim()).filter(Boolean);
const env = require('./env_core');
let _fakeNavigatorRef = null;

// ---------- 设备信号（固定软件指纹）----------
// ---------- 设备信号（2026-08-16 Chrome DevTools 从真实浏览器实抓）----------
// 版本必须与真实浏览器一致：Castle 把 UA / UA-CH 直接编进 token，
// 写成别的版本 → token 内容与浏览器不符 → 被风控识别。
const CHROME_MAJOR = '153';
const CHROME_FULL = '153.0.8010.53';
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
const brands = [
  { brand: 'Google Chrome', version: CHROME_MAJOR },
  { brand: 'Not_A Brand', version: '8' },
  { brand: 'Chromium', version: CHROME_MAJOR },
];
const fullVersionList = [
  { brand: 'Google Chrome', version: CHROME_FULL },
  { brand: 'Not_A Brand', version: '8.0.0.0' },
  { brand: 'Chromium', version: CHROME_FULL },
];

// ---------- WebGPU（navigator.gpu）----------
// Castle 有两路信号（id 860 / 870）走 WebGPU：860 把 `Object.keys(Object.getPrototypeOf(
// adapter.limits))` 逐项取值拼起来做哈希，870 取 adapter.info 的 vendor/architecture 与
// features.size。缺 navigator.gpu 这两路直接不产出。数值按真机 Chrome 151 实抓，
// 与上面 WebGL 的 RTX 5060 Ti（Blackwell）保持一致。
const _GPU_LIMITS = {
  maxTextureDimension1D: 16384, maxTextureDimension2D: 16384, maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 2048, maxBindGroups: 4, maxBindGroupsPlusVertexBuffers: 24,
  maxBindingsPerBindGroup: 1000, maxDynamicUniformBuffersPerPipelineLayout: 10,
  maxDynamicStorageBuffersPerPipelineLayout: 8, maxSampledTexturesPerShaderStage: 48,
  maxSamplersPerShaderStage: 16, maxStorageBuffersPerShaderStage: 16,
  maxStorageTexturesPerShaderStage: 8, maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536, maxStorageBufferBindingSize: 2147483644,
  minUniformBufferOffsetAlignment: 256, minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8, maxBufferSize: 2147483648, maxVertexAttributes: 30,
  maxVertexBufferArrayStride: 2048, maxInterStageShaderVariables: 28, maxColorAttachments: 8,
  maxColorAttachmentBytesPerSample: 128, maxComputeWorkgroupStorageSize: 32768,
  maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 1024,
  maxComputeWorkgroupSizeY: 1024, maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535, maxImmediateSize: 64,
  maxStorageBuffersInFragmentStage: 16, maxStorageTexturesInFragmentStage: 8,
  maxStorageBuffersInVertexStage: 16, maxStorageTexturesInVertexStage: 8,
};
const _GPU_INFO = {
  vendor: 'nvidia', architecture: 'blackwell', device: '', description: '',
  subgroupMinSize: 32, subgroupMaxSize: 32, isFallbackAdapter: false,
};
const _GPU_FEATURES = ['depth32float-stencil8', 'rg11b10ufloat-renderable', 'bgra8unorm-storage',
  'texture-formats-tier1', 'texture-compression-bc', 'dual-source-blending',
  'core-features-and-limits', 'float32-filterable', 'indirect-first-instance',
  'float32-blendable', 'depth-clip-control', 'texture-compression-bc-sliced-3d', 'shader-f16',
  'timestamp-query', 'texture-formats-tier2', 'clip-distances', 'primitive-index',
  'texture-component-swizzle', 'subgroups'];
// 真实 Chrome 里 limits / info 的属性都挂在**原型**上（own keys 为空），
// SDK 正是 getPrototypeOf 再 keys 取名字的，形状必须一致。
function _protoBacked(values, tag) {
  const proto = {};
  for (const k of Object.keys(values)) {
    Object.defineProperty(proto, k, { get: () => values[k], enumerable: true, configurable: true });
  }
  env.setObjNative(proto, tag);
  return Object.create(proto);
}
const fakeGPU = {
  wgslLanguageFeatures: new Set(['packed_4x8_integer_dot_product', 'subgroup_uniformity',
    'immediate_address_space', 'linear_indexing', 'subgroup_id',
    'readonly_and_readwrite_storage_textures', 'unrestricted_pointer_parameters',
    'texture_and_sampler_let', 'pointer_composite_access', 'uniform_buffer_standard_layout']),
  getPreferredCanvasFormat: () => 'bgra8unorm',
  requestAdapter: () => Promise.resolve(_gpuAdapter),
};
const _gpuAdapter = _protoBacked({
  features: new Set(_GPU_FEATURES),
  limits: _protoBacked(_GPU_LIMITS, 'GPUSupportedLimits'),
  info: _protoBacked(_GPU_INFO, 'GPUAdapterInfo'),
  requestDevice: () => Promise.reject(new Error('device creation failed')),
}, 'GPUAdapter');

const fakeNavigator = {
  userAgent: UA,
  gpu: fakeGPU,
  appVersion: `5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  appName: 'Netscape',
  appCodeName: 'Mozilla',
  product: 'Gecko',
  productSub: '20030107',
  platform: 'Win32',
  vendor: 'Google Inc.',
  vendorSub: '',
  language: 'zh-CN',
  // 当前实际 Chrome 153 页面的 navigator.languages 只有这两个值；多补
  // fallback 语言会直接改变 Castle 的数组长度/压缩字节数。
  languages: ['zh-CN', 'zh'],
  hardwareConcurrency: 20,
  deviceMemory: 32,
  maxTouchPoints: 10,
  webdriver: false,
  cookieEnabled: true,
  doNotTrack: null,
  onLine: true,
  plugins: [],
  mimeTypes: [],
  // 上面两个占位会在 _pluginData 构好后被真实列表覆盖（见文件下方 Object.assign）
  // 实抓：Chrome 上这两个是真实存在的值，早期版本缺失导致 Castle 少采一项
  pdfViewerEnabled: true,
  javaEnabled: () => false,
  // 实抓：Chrome 暴露这些 API 对象（缺失会被判定为非真实浏览器）
  bluetooth: { getAvailability: () => Promise.resolve(false), getDevices: () => Promise.resolve([]), addEventListener() {}, removeEventListener() {} },
  credentials: { get: () => Promise.resolve(null), store: () => Promise.resolve(), create: () => Promise.resolve(null), preventSilentAccess: () => Promise.resolve() },
  usb: { getDevices: () => Promise.resolve([]), addEventListener() {}, removeEventListener() {} },
  serial: { getPorts: () => Promise.resolve([]), addEventListener() {}, removeEventListener() {} },
  hid: { getDevices: () => Promise.resolve([]), addEventListener() {}, removeEventListener() {} },
  wakeLock: { request: () => Promise.resolve({ release: () => Promise.resolve(), addEventListener() {} }) },
  presentation: { defaultRequest: null, receiver: null },
  scheduling: { isInputPending: () => false },
  // 实抓：这些在真实 Chrome 上就是 undefined（Firefox/Safari/Brave 专有），保持缺失才对
  // brave / standalone / buildID / oscpu / msDoNotTrack 一律不定义
  storage: { estimate: () => Promise.resolve({ usage: 0, quota: 120000000000 }), persisted: () => Promise.resolve(false) },
  webkitTemporaryStorage: { queryUsageAndQuota: (cb) => { try { if (typeof cb === 'function') cb(0, 120000000000); } catch (e) {} } },
  webkitPersistentStorage: { queryUsageAndQuota: (cb) => { try { if (typeof cb === 'function') cb(0, 120000000000); } catch (e) {} } },
  permissions: { query: () => Promise.resolve({ state: 'prompt', onchange: null, addEventListener() {}, removeEventListener() {} }) },
  // 实抓：x.com 注册了 /sw.js 并已 activated，controller 非空。给个已激活的注册，
  // `ready` 必须能 resolve——真浏览器上没注册时它永不 resolve，照搬会挂死采集器。
  serviceWorker: (() => {
    const worker = { scriptURL: 'https://x.com/sw.js', state: 'activated', onstatechange: null, postMessage() {}, addEventListener() {} };
    const reg = {
      scope: 'https://x.com/', updateViaCache: 'imports',
      installing: null, waiting: null, active: worker,
      navigationPreload: { getState: () => Promise.resolve({ enabled: false, headerValue: '' }) },
      update: () => Promise.resolve(), unregister: () => Promise.resolve(true),
      addEventListener() {}, removeEventListener() {},
    };
    return {
      controller: worker, ready: Promise.resolve(reg),
      oncontrollerchange: null, onmessage: null, onmessageerror: null,
      getRegistration: () => Promise.resolve(reg),
      getRegistrations: () => Promise.resolve([reg]),
      register: () => Promise.resolve(reg),
      startMessages() {},
      addEventListener() {}, removeEventListener() {},
    };
  })(),
  mediaDevices: { enumerateDevices: () => Promise.resolve([]), getUserMedia: () => Promise.reject(new Error('denied')), addEventListener() {} },
  getBattery: () => Promise.resolve({ level: 1, charging: true, chargingTime: 0, dischargingTime: Infinity, addEventListener() {} }),
  connection: { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false, type: 'wifi', addEventListener() {}, removeEventListener() {} },
  locks: { request: (name, opts, cb) => Promise.resolve(typeof opts === 'function' ? opts({ name }) : (cb ? cb({ name }) : undefined)), query: () => Promise.resolve({ held: [], pending: [] }) },
  clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
  userAgentData: {
    brands: brands,
    mobile: false,
    platform: 'Windows',
    getHighEntropyValues: (hints) => Promise.resolve({
      architecture: 'x86',
      bitness: '64',
      brands: brands,
      formFactors: ['Desktop'],
      fullVersionList: fullVersionList,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '19.0.0',
      uaFullVersion: CHROME_FULL,
      wow64: false,
    }),
    toJSON() { return { brands, mobile: false, platform: 'Windows' }; },
  },
};

const fakeLocation = {
  href: 'https://x.com/i/jf/onboarding/web',
  origin: 'https://x.com',
  protocol: 'https:',
  host: 'x.com',
  hostname: 'x.com',
  port: '',
  pathname: '/i/jf/onboarding/web',
  search: '',
  hash: '',
  assign() {}, replace() {}, reload() {},
  toString() { return this.href; },
};

// ---------- plugins / mimeTypes（2026-08-16 真实 Chrome 实抓）----------
// 早期版本给的是空数组，真实 Chrome 有 5 个内置 PDF 插件 + 2 个 mimeType，
// Castle 会枚举 name/filename/description，空数组等于少采集一大块。
const _PLUGIN_DEFS = [
  ['PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
  ['Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
  ['Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
  ['Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
  ['WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'],
];
const _MIME_DEFS = [
  ['application/pdf', 'pdf', 'Portable Document Format'],
  ['text/pdf', 'pdf', 'Portable Document Format'],
];
function _buildPlugins() {
  const mimes = _MIME_DEFS.map(([type, suffixes, description]) => ({
    type, suffixes, description, enabledPlugin: null,
  }));
  const plugins = _PLUGIN_DEFS.map(([name, filename, description]) => {
    const p = { name, filename, description, length: mimes.length,
                item(i) { return mimes[i] || null; },
                namedItem(n) { return mimes.find((m) => m.type === n) || null; } };
    mimes.forEach((m, i) => { p[i] = m; });
    return p;
  });
  mimes.forEach((m) => { m.enabledPlugin = plugins[0]; });
  const mkList = (arr, key) => {
    const list = { length: arr.length,
      item(i) { return arr[i] || null; },
      namedItem(n) { return arr.find((x) => x[key] === n) || null; },
      refresh() {},
      [Symbol.iterator]() { return arr[Symbol.iterator](); } };
    arr.forEach((x, i) => { list[i] = x; list[x[key]] = x; });
    return list;
  };
  return { plugins: mkList(plugins, 'name'), mimeTypes: mkList(mimes, 'type') };
}
const _pluginData = _buildPlugins();
_fakeNavigatorRef = fakeNavigator;
// 用实抓的真实列表覆盖 fakeNavigator 里的空数组占位
fakeNavigator.plugins = _pluginData.plugins;
fakeNavigator.mimeTypes = _pluginData.mimeTypes;
if (process.env.CASTLE_LANGUAGES_JSON) {
  try { fakeNavigator.languages = JSON.parse(process.env.CASTLE_LANGUAGES_JSON); } catch (e) {}
}

// ---------- 字体度量（2026-08-16 真实浏览器实抓，font-size:72px）----------
// Castle 用 measureText 比较各字体宽度来探测已安装字体（实抓调了 151 次）。
// 早期版本返回线性近似值 → 所有字体宽度相同 → 探测结果全是「未安装」，
// 与真实浏览器（51/58 已安装）差一大截，载荷因此偏小。
const _FONT_RATIO_72 = {
  "Arial": 49.828125,
  "Arial Black": 60.918269,
  "Arial Narrow": 49.828125,
  "Calibri": 48.05649,
  "Cambria": 50.628606,
  "Candara": 49.094952,
  "Comic Sans MS": 47.612981,
  "Consolas": 39.586538,
  "Courier": 43.207933,
  "Courier New": 43.207933,
  "Georgia": 53.578125,
  "Helvetica": 49.828125,
  "Impact": 47.253606,
  "Lucida Console": 43.383413,
  "Lucida Sans Unicode": 56.509615,
  "Microsoft Sans Serif": 49.925481,
  "Palatino Linotype": 53.729567,
  "Segoe UI": 51.728365,
  "Tahoma": 50.332933,
  "Times": 47.697115,
  "Times New Roman": 47.697115,
  "Trebuchet MS": 50.819712,
  "Verdana": 58.430288,
  "Wingdings": 65.350962,
  "MS Gothic": 36.0,
  "MS PGothic": 44.177885,
  "SimSun": 36.0,
  "SimHei": 36.0,
  "Microsoft YaHei": 56.31851,
  "NSimSun": 36.0,
  "FangSong": 36.0,
  "KaiTi": 36.0,
  "Malgun Gothic": 52.820913,
  "Segoe Print": 61.697115,
  "Segoe Script": 62.71875,
  "Sylfaen": 50.209135,
  "Gabriola": 37.486779,
  "Ebrima": 51.728365,
  "Nirmala UI": 51.728365,
  "Leelawadee UI": 51.728365,
  "Javanese Text": 50.179087,
  "Segoe UI Emoji": 51.728365,
  "Segoe UI Symbol": 51.728365,
  "MV Boli": 51.760817,
  "Myanmar Text": 51.728365,
  "Mongolian Baiti": 47.697115,
  "Franklin Gothic Medium": 52.25601,
  "Bahnschrift": 52.03125,
  "Ink Free": 44.90625,
  "Corbel": 49.746394,
  "Constantia": 52.653846,
  "Book Antiqua": 36.0,
  "Bookman Old Style": 36.0,
  "Century Gothic": 36.0,
  "Garamond": 36.0,
  "Rockwell": 36.0,
  "Perpetua": 36.0,
  "Baskerville Old Face": 36.0
};
const _BASE_RATIO_72 = {"monospace": 36.0, "sans-serif": 55.955529, "serif": 59.483173};

// ---------- WebGL / Canvas 2D 上下文（2026-08-16 真实 Chrome 实抓）----------
// 早期版本 getContext() 一律返回 null —— Castle 诊断显示调了 28 次
// (webgl/experimental-webgl/2d)，null 等于 WebGL 指纹一个字节都不产出。
const _GL_EXTENSIONS = ['ANGLE_instanced_arrays','EXT_blend_minmax','EXT_clip_control','EXT_color_buffer_half_float','EXT_depth_clamp','EXT_disjoint_timer_query','EXT_float_blend','EXT_frag_depth','EXT_polygon_offset_clamp','EXT_shader_texture_lod','EXT_texture_compression_bptc','EXT_texture_compression_rgtc','EXT_texture_filter_anisotropic','EXT_texture_mirror_clamp_to_edge','EXT_sRGB','KHR_parallel_shader_compile','OES_element_index_uint','OES_fbo_render_mipmap','OES_standard_derivatives','OES_texture_float','OES_texture_float_linear','OES_texture_half_float','OES_texture_half_float_linear','OES_vertex_array_object','WEBGL_blend_func_extended','WEBGL_color_buffer_float','WEBGL_compressed_texture_s3tc','WEBGL_compressed_texture_s3tc_srgb','WEBGL_debug_renderer_info','WEBGL_debug_shaders','WEBGL_depth_texture','WEBGL_draw_buffers','WEBGL_lose_context','WEBGL_multi_draw','WEBGL_polygon_mode'];
const _GL_VALUES = {
  0x1F00: 'WebKit', 0x1F01: 'WebKit WebGL',
  0x1F02: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
  0x8B8C: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
  0x9245: 'Google Inc. (NVIDIA)',
  0x9246: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Ti (0x00002D04) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  0x0D33: 16384, 0x84E8: 16384, 0x851C: 16384,
  0x8869: 16, 0x8DFB: 4095, 0x8DFD: 1024, 0x8DFC: 30,
  0x8872: 16, 0x8B4C: 16, 0x8B4D: 32,
  0x0D52: 8, 0x0D53: 8, 0x0D54: 8, 0x0D55: 8, 0x0D56: 24, 0x0D57: 0, 0x0D50: 4,
};
const _GL_ARRAYS = {
  0x0D3A: () => new Int32Array([32767, 32767]),
  0x846E: () => new Float32Array([1, 1]),
  0x846D: () => new Float32Array([1, 1024]),
};
// 枚举常量反查（getParameter 收到枚举值时用）
const _GL_ENUM_REVERSE = {
  VENDOR: 0x1F00, RENDERER: 0x1F01, VERSION: 0x1F02, SHADING_LANGUAGE_VERSION: 0x8B8C,
  MAX_TEXTURE_SIZE: 0x0D33, MAX_VIEWPORT_DIMS: 0x0D3A, MAX_RENDERBUFFER_SIZE: 0x84E8,
  MAX_VERTEX_ATTRIBS: 0x8869, MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD, MAX_VARYING_VECTORS: 0x8DFC,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C,
  ALIASED_LINE_WIDTH_RANGE: 0x846E, ALIASED_POINT_SIZE_RANGE: 0x846D,
  RED_BITS: 0x0D52, GREEN_BITS: 0x0D53, BLUE_BITS: 0x0D54, ALPHA_BITS: 0x0D55,
  DEPTH_BITS: 0x0D56, STENCIL_BITS: 0x0D57, SUBPIXEL_BITS: 0x0D50,
  UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246,
  // 着色器编译相关枚举（Castle 的字体探针会创建着色器，少这些会返回 undefined）
  VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
  COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82, VALIDATE_STATUS: 0x8B83,
  DELETE_STATUS: 0x8B80, SHADER_TYPE: 0x8B4F,
  // texture / buffer / blend 常见枚举（防止其他探针 undefined）
  TEXTURE_2D: 0x0DE1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
  NEAREST: 0x2600, LINEAR: 0x2601,
  ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88B4,
  TRIANGLE_STRIP: 0x0005, TRIANGLE_FAN: 0x0006, TRIANGLES: 0x0004,
  POINTS: 0x0000, LINES: 0x0001, LINE_LOOP: 0x0002, LINE_STRIP: 0x0003,
  FLOAT: 0x1406, INT: 0x1404,
  COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100,
};
function makeWebGL(canvas) {
  const gl = {};
  // 挂枚举常量（让 gl.VENDOR 等直接可访问）
  Object.assign(gl, _GL_ENUM_REVERSE);
  gl.canvas = canvas;
  gl.drawingBufferWidth = (canvas && canvas.width) || 300;
  gl.drawingBufferHeight = (canvas && canvas.height) || 150;
  gl.getParameter = function (p) {
    if (_GL_ARRAYS[p]) return _GL_ARRAYS[p]();
    return p in _GL_VALUES ? _GL_VALUES[p] : null;
  };
  gl.getSupportedExtensions = () => _GL_EXTENSIONS.slice();
  gl.getExtension = (name) => {
    if (name === 'WEBGL_debug_renderer_info')
      return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
    if (_GL_EXTENSIONS.indexOf(name) < 0) return null;
    if (name === 'WEBGL_lose_context') return { loseContext() {}, restoreContext() {} };
    if (name === 'EXT_texture_filter_anisotropic')
      return { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF, TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE };
    return {};
  };
  gl.getContextAttributes = () => ({ alpha: true, antialias: true, depth: true,
    desynchronized: false, failIfMajorPerformanceCaveat: false, powerPreference: 'default',
    premultipliedAlpha: true, preserveDrawingBuffer: false, stencil: false, xrCompatible: false });
  gl.getShaderPrecisionFormat = () => ({ rangeMin: 127, rangeMax: 127, precision: 23 });
  // 着色器链路：返回可用对象 + 成功状态（真实 GL 编译会成功，返回 null 会让探针走异常分支）
  gl.createShader = (t) => ({ __shader: t });
  gl.createProgram = () => ({ __program: true });
  gl.createBuffer = () => ({ __buffer: true });
  gl.createTexture = () => ({ __texture: true });
  gl.getShaderParameter = (s, p) => (p === 0x8B81 ? true : null);   // COMPILE_STATUS
  gl.getProgramParameter = (p, n) => (n === 0x8B82 ? true : null);  // LINK_STATUS
  gl.getShaderInfoLog = () => '';
  gl.getProgramInfoLog = () => '';
  gl.getAttribLocation = () => 0;
  gl.getUniformLocation = () => ({ __loc: true });
  for (const m of ['bindBuffer','bufferData','shaderSource',
    'compileShader','attachShader','linkProgram','useProgram',
    'enableVertexAttribArray',
    'vertexAttribPointer','uniform1f','uniform1i','uniform2f','uniform2fv','uniform3f',
    'uniform3fv','uniform4f','uniform4fv','uniformMatrix4fv',
    'drawArrays','drawElements','viewport','clearColor',
    'clear','enable','disable','readPixels','deleteBuffer','deleteShader',
    'deleteProgram','activeTexture',
    'bindTexture','texParameteri','texImage2D','finish','flush']) {
    if (!(m in gl)) gl[m] = function () { return null; };   // 不覆盖上面已实现的
  }
  return gl;
}
function make2D(canvas) {
  return {
    canvas, fillStyle: '#000', strokeStyle: '#000', font: '10px sans-serif',
    textBaseline: 'alphabetic', textAlign: 'start', globalAlpha: 1,
    lineWidth: 1, shadowBlur: 0, globalCompositeOperation: 'source-over',
    fillRect() {}, strokeRect() {}, clearRect() {}, fillText() {}, strokeText() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {},
    bezierCurveTo() {}, quadraticCurveTo() {}, fill() {}, stroke() {}, clip() {},
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    transform() {}, setTransform() {}, drawImage() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createPattern() { return null; },
    // 按 ctx.font 里的字号+字体名，用实抓比率算宽度。
    // Castle 靠「同一串文字在不同 font 下宽度是否相同」判断字体是否安装，
    // 所以这里必须**按字体返回不同值**，否则探测结果全是「未安装」。
    measureText(t) {
      const s = String(t == null ? '' : t);
      const font = String(this.font || '10px sans-serif');
      // 解析字号（px）
      const mSize = font.match(/(\d+(?:\.\d+)?)px/);
      const size = mSize ? parseFloat(mSize[1]) : 10;
      // 解析字体族：取第一个族名，去掉引号
      let fam = font.replace(/^.*?\d+(?:\.\d+)?px\s*/, '').split(',')[0]
                    .trim().replace(/^["']|["']$/g, '');
      // 实抓比率表是 72px 基准的「每字符宽度」
      let ratio = _FONT_RATIO_72[fam];
      if (ratio === undefined) ratio = _BASE_RATIO_72[fam];
      if (ratio === undefined) {
        // 未登记字体：浏览器会回退到 fallback 族（Castle 据此判定「未安装」）
        const fb = font.toLowerCase();
        ratio = fb.indexOf('monospace') >= 0 ? _BASE_RATIO_72.monospace
              : fb.indexOf('serif') >= 0 && fb.indexOf('sans') < 0 ? _BASE_RATIO_72.serif
              : _BASE_RATIO_72['sans-serif'];
      }
      const w = s.length * ratio * (size / 72);
      return { width: w, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w,
               actualBoundingBoxAscent: size * 0.72, actualBoundingBoxDescent: size * 0.21,
               fontBoundingBoxAscent: size * 0.93, fontBoundingBoxDescent: size * 0.21,
               emHeightAscent: size * 0.8, emHeightDescent: size * 0.2,
               alphabeticBaseline: 0, hangingBaseline: size * 0.8, ideographicBaseline: -size * 0.2 };
    },
    getImageData(x, y, w, h) {
      return { data: new Uint8ClampedArray(Math.max(0, (w || 0) * (h || 0) * 4)), width: w, height: h };
    },
    putImageData() {}, createImageData(w, h) {
      return { data: new Uint8ClampedArray(Math.max(0, (w || 0) * (h || 0) * 4)), width: w, height: h };
    },
    isPointInPath() { return false; },
    toDataURL(type) {
      // 实抓：真实 canvas.toDataURL() 返回 PNG data URL，长度约 4618
      // 用固定但合理长度的假值，让依赖 length 的指纹代码拿到非零值
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAARgAAAA8CAYAAACyyLT2AAACR0lEQVR4Ae3BMQEAAADCIPunNsc+VAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB+BgwAAQaanNQAAAABJRU5ErkJggg==';
    },
  };
}

const _CAN_PLAY = {
  video: {
    'video/mp4; codecs="avc1.42e01e"': 'probably',
    'video/mp4; codecs="avc1.42e01e, mp4a.40.2"': 'probably',
    'video/webm; codecs="vp8"': 'probably',
    'video/webm; codecs="vp8, vorbis"': 'probably',
    'video/webm; codecs="vp9"': 'probably',
    'video/ogg; codecs="theora"': '',        // 实抓：Chrome 返回空串
    'video/mp4': 'maybe', 'video/webm': 'maybe', 'video/ogg': 'maybe',
  },
  audio: {
    'audio/mpeg': 'probably', 'audio/mp4; codecs="mp4a.40.2"': 'probably',
    'audio/wav; codecs="1"': 'probably', 'audio/ogg; codecs="vorbis"': 'probably',
    'audio/aac': 'probably', 'audio/ogg; codecs="opus"': 'probably',
    'audio/wav': 'maybe', 'audio/ogg': 'maybe',
  },
};
function makeCanPlayType(tag) {
  const table = _CAN_PLAY[tag] || {};
  return function canPlayType(type) {
    const key = String(type || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (key in table) return table[key];
    const base = key.split(';')[0].trim();
    if (base in table) return table[base];
    // 未知类型：Chrome 返回空串
    return '';
  };
}
// iframe 在 Castle 的环境采集阶段会被 append 到 document.body 后立即读取
// contentWindow/contentDocument。它们必须指向同一份 fake window/document；
// 这里使用延迟绑定，因为 makeElement 定义在 fakeWindow 组装之前。
let _fakeWindowRef = null;
let _fakeDocumentRef = null;
// env.createProxy 会把 iframe.contentWindow 上的内建函数包成轻量代理，
// 该代理的 Date.prototype 只保留 constructor。Castle 只需要一个干净的
// getTimezoneOffset；返回带自有方法的 Date 实例可避免跨代理丢失原型链。
function makeIframeDate(...args) {
  // env.createProxy 的函数包装通过 apply 调用原函数，因此这里不能依赖
  // new.target；无论调用形式都返回一个带自有方法的轻量实例。
  return { getTimezoneOffset: () => new Date(...args).getTimezoneOffset() };
}
const _eventBuckets = { document: new Map(), window: new Map() };
function _addEvent(bucket, type, fn) {
  if (typeof fn !== 'function') return;
  const list = bucket.get(String(type)) || [];
  list.push(fn); bucket.set(String(type), list);
}
function _removeEvent(bucket, type, fn) {
  const list = bucket.get(String(type));
  if (!list) return;
  bucket.set(String(type), list.filter((x) => x !== fn));
}
function _dispatchEvent(bucket, type, event) {
  const list = bucket.get(String(type)) || [];
  for (const fn of list.slice()) { try { fn.call(null, event); } catch (e) {} }
}
function makeElement(tag) {
  tag = String(tag || 'div').toLowerCase();
  const style = {
    setProperty() {}, getPropertyValue() { return ''; },
    removeProperty() { return ''; }, item() { return ''; }, length: 0,
  };
  // 不用对象字面量自引用——改用局部变量，getContext 才能正确闭包引用 el
  const el = {};
  el.tagName = tag.toUpperCase(); el.nodeName = tag.toUpperCase(); el.nodeType = 1;
  el.style = style;
  el.width = 300; el.height = 150;       // canvas 默认尺寸
  el.setAttribute = function() {};
  el.getAttribute = function() { return null; };
  el.removeAttribute = function() {};
  el.hasAttribute = function() { return false; };
  // 实抓：Castle 的 webdriver 检测会走 `el.attributes[name].specified` 这条回退路径，
  // 缺 attributes 直接 TypeError，打死整个 Pd() 采集器。
  el.attributes = { length: 0, item() { return null; }, getNamedItem() { return null; } };
  el.appendChild = function(c) {
    if (c && c.tagName === 'IFRAME') {
      if (!c.contentWindow) c.contentWindow = _fakeWindowRef;
      if (c.contentWindow && !c.contentWindow.navigator) c.contentWindow.navigator = _fakeNavigatorRef;
      if (!c.contentDocument) c.contentDocument = _fakeDocumentRef;
      c.isConnected = true;
    }
    return c;
  };
  el.removeChild = function(c) { return c; };
  el.remove = function() {};             // 实抓：真实元素有 remove()
  el.addEventListener = function() {};
  el.removeEventListener = function() {};
  el.getContext = function(type) {
    if (tag !== 'canvas') return null;
    const t = String(type || '').toLowerCase();
    // 当前实际 Castle 登录页的 Chrome 运行时中，WebGL 上下文探针返回 null
    // （远程调试环境没有启用 WebGL）。默认保持该形状；只有显式打开
    // CASTLE_FAKE_WEBGL=1 时才提供完整的可编程 WebGL 存根。
    if (t === 'webgl' || t === 'experimental-webgl' || t === 'webgl2') {
      return process.env.CASTLE_FAKE_WEBGL === '1' ? makeWebGL(el) : null;
    }
    if (t === '2d') return make2D(el);
    return null;
  };
  el.toDataURL = function(type) { return make2D(el).toDataURL(type); };
  el.getBoundingClientRect = function() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; };
  el.getClientRects = function() { return []; };
  // 实抓：字体探测靠 offsetParent + offsetWidth/Height 判断元素是否已渲染（被调 114 次）。
  // 真实页面里元素 appendChild 到 body 后 offsetParent 是 BODY，不是 undefined。
  el.offsetParent = null;   // 见下方 appendChild：入 DOM 后置为 body
  el.isConnected = false;
  el.offsetWidth = 0; el.offsetHeight = 0;
  el.offsetTop = 0; el.offsetLeft = 0;
  el.clientWidth = 0; el.clientHeight = 0;
  el.scrollWidth = 0; el.scrollHeight = 0;
  if (tag === 'iframe') {
    // 实抓：iframe 入 DOM 后 contentWindow 是 Window 对象
    el.contentWindow = { Date: makeIframeDate, navigator: _fakeNavigatorRef };
    el.contentDocument = _fakeDocumentRef;
  }
  el.children = []; el.childNodes = []; el.parentNode = null; el.firstChild = null;
  el.innerHTML = ''; el.outerHTML = ''; el.textContent = '';
  el.classList = { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } };
  if (tag === 'video' || tag === 'audio') el.canPlayType = makeCanPlayType(tag);
  return el;
}
const _QUERY_META_DEFAULT =   [
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "SCRIPT",
      0,
      "https://accounts.google.com/gsi/client",
      ""
    ],
    [
      "SCRIPT",
      0,
      "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js",
      ""
    ],
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      7,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      7,
      "",
      ""
    ],
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      0,
      "",
      ""
    ],
    [
      "P",
      7,
      "",
      ""
    ],
    [
      "STYLE",
      0,
      "",
      ""
    ],
    [
      "SCRIPT",
      0,
      "",
      ""
    ],
    [
      "SCRIPT",
      0,
      "",
      ""
    ],
    [
      "SCRIPT",
      0,
      "",
      ""
    ],
    [
      "SCRIPT",
      0,
      "",
      ""
    ],
    [
      "SCRIPT",
      0,
      "",
      ""
    ],
    [
      "SCRIPT",
      0,
      "",
      ""
    ],
    [
      "SCRIPT",
      0,
      "https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload",
      ""
    ],
    [
      "SCRIPT",
      0,
      "https://abs.twimg.com/responsive-web/client-web/vendor.468337bb351e1ee9a.js",
      ""
    ],
    [
      "SCRIPT",
      0,
      "https://abs.twimg.com/responsive-web/client-web/i18n/zh.0434ed0af43eb437a.js",
      ""
    ],
    [
      "SCRIPT",
      0,
      "https://abs.twimg.com/responsive-web/client-web/main.60bedca26c9a9faaa.js",
      ""
    ],
    [
      "SCRIPT",
      0,
      "",
      ""
    ],
    [
      "SCRIPT",
      0,
      "https://accounts.google.com/gsi/client",
      ""
    ]
  ];
const _QUERY_META = (() => {
  const raw = process.env.CASTLE_QUERY_COLLECTION_JSON_B64;
  if (!raw) return _QUERY_META_DEFAULT;
  try {
    const v = JSON.parse(_Buffer.from(raw, 'base64').toString('utf8'));
    return Array.isArray(v) ? v : _QUERY_META_DEFAULT;
  } catch (e) { return _QUERY_META_DEFAULT; }
})();
const _QUERY_ELEMENTS = _QUERY_META.map(([tag, childCount, src, href]) => {
  const el = makeElement(tag || 'div');
  el.childElementCount = Number(childCount) || 0;
  el.src = src || '';
  el.href = href || '';
  return el;
});

// x-web Castle 的 Ho() 元素指纹不是 querySelectorAll('img, style, script, p')，
// 而是 querySelectorAll('*') 的前 256 个节点，只读取 tagName 与
// childElementCount。真实 clean onboarding 页的这组顺序/值固定在这里；
// 可用 CASTLE_ALL_ELEMENTS_JSON_B64 由采集器覆盖，便于页面 DOM 漂移时更新。
const _ALL_ELEMENTS_META_DEFAULT = [["HTML",2],["HEAD",79],["STYLE",0],["STYLE",0],["STYLE",0],["STYLE",0],["META",0],["META",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["META",0],["META",0],["META",0],["META",0],["META",0],["LINK",0],["LINK",0],["LINK",0],["META",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["META",0],["META",0],["META",0],["STYLE",0],["STYLE",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["LINK",0],["STYLE",0],["STYLE",0],["SCRIPT",0],["SCRIPT",0],["STYLE",0],["STYLE",0],["LINK",0],["TITLE",0],["META",0],["META",0],["META",0],["META",0],["META",0],["META",0],["META",0],["META",0],["META",0],["META",0],["META",0],["META",0],["META",0],["META",0],["BODY",14],["NOSCRIPT",0],["DIV",1],["DIV",1],["DIV",2],["DIV",2],["DIV",1],["DIV",1],["DIV",1],["DIV",0],["DIV",1],["DIV",1],["DIV",1],["DIV",1],["DIV",1],["DIV",3],["DIV",0],["DIV",2],["DIV",0],["DIV",1],["DIV",1],["DIV",2],["DIV",1],["FORM",2],["DIV",3],["DIV",1],["DIV",1],["BUTTON",2],["DIV",1],["SPAN",1],["svg",1],["path",0],["DIV",1],["SPAN",1],["svg",1],["path",0],["DIV",2],["DIV",3],["DIV",0],["DIV",1],["DIV",1],["SPAN",1],["svg",1],["path",0],["DIV",0],["DIV",1],["DIV",1],["DIV",1],["DIV",3],["DIV",2],["DIV",2],["DIV",2],["SPAN",1],["svg",1],["path",0],["DIV",1],["P",0],["DIV",1],["P",0],["DIV",1],["DIV",1],["P",0],["DIV",1],["DIV",4],["DIV",3],["BUTTON",1],["DIV",1],["DIV",2],["SPAN",1],["svg",1],["path",0],["DIV",1],["P",0],["DIV",1],["DIV",2],["DIV",2],["SPAN",1],["svg",4],["path",0],["path",0],["path",0],["path",0],["DIV",2],["DIV",1],["DIV",2],["SPAN",1],["svg",5],["path",0],["path",0],["path",0],["path",0],["path",0],["DIV",1],["P",0],["DIV",1],["DIV",2],["SPAN",1],["svg",5],["path",0],["path",0],["path",0],["path",0],["path",0],["DIV",1],["P",0],["DIV",1],["DIV",2],["DIV",0],["IFRAME",0],["BUTTON",2],["DIV",1],["DIV",2],["SPAN",1],["svg",1],["path",0],["DIV",1],["P",0],["DIV",1],["DIV",2],["SPAN",1],["svg",1],["path",0],["DIV",1],["P",0],["DIV",3],["DIV",0],["DIV",1],["P",0],["DIV",0],["DIV",1],["DIV",0],["LABEL",1],["DIV",4],["SPAN",0],["SPAN",0],["INPUT",0],["INPUT",0],["DIV",1],["DIV",2],["BUTTON",1],["DIV",1],["DIV",1],["DIV",1],["svg",2],["circle",0],["circle",0],["DIV",1],["DIV",1],["DIV",1],["P",7],["SPAN",0],["A",0],["SPAN",0],["A",0],["SPAN",0],["A",0],["SPAN",0],["DIV",0],["DIV",1],["DIV",2],["BUTTON",1],["DIV",1],["DIV",1],["DIV",1],["svg",2],["circle",0],["circle",0],["DIV",1],["DIV",1],["DIV",1],["P",7],["SPAN",0],["A",0],["SPAN",0],["A",0]];
const _ALL_ELEMENTS_META = (() => {
  const raw = process.env.CASTLE_ALL_ELEMENTS_JSON_B64;
  if (!raw) return _ALL_ELEMENTS_META_DEFAULT;
  try {
    const v = JSON.parse(_Buffer.from(raw, 'base64').toString('utf8'));
    return Array.isArray(v) ? v : _ALL_ELEMENTS_META_DEFAULT;
  } catch (e) { return _ALL_ELEMENTS_META_DEFAULT; }
})();
const _ALL_ELEMENTS = _ALL_ELEMENTS_META.map(([tag, childCount]) => {
  const el = makeElement(tag || 'div');
  // SVG/MathML tagName casing is lowercase in the captured HTML document.
  el.tagName = String(tag || 'div');
  el.nodeName = String(tag || 'div');
  el.childElementCount = Number(childCount) || 0;
  return el;
});
// Gce caps element property reads at 256, but Ho() also records the full
// collection length (467 at the begin_login capture point).  Keep the tail as
// sparse holes so indexed reads stay identical while `c.length` is real.
_ALL_ELEMENTS.length = Number(process.env.CASTLE_ALL_ELEMENTS_COUNT || 467) || 467;
const _ALL_ELEMENTS_ENABLED = String(process.env.CASTLE_ALL_ELEMENTS || '') === '1';

const fakeDocument = {
  // 登录器可以把真实页面的 document.cookie 通过 CASTLE_COOKIE 传进来；
  // 默认空串保持离线 runner 的既有行为。
  cookie: process.env.CASTLE_COOKIE || (process.env.CASTLE_COOKIE_B64
    ? (() => { try { return _Buffer.from(process.env.CASTLE_COOKIE_B64, 'base64').toString('utf8'); } catch (e) { return ''; } })()
    : ''),
  referrer: '',
  title: 'X',
  readyState: 'complete',
  visibilityState: 'visible',
  hidden: false,
  // 实抓：真实 Chrome 上这些有确定取值，缺失会让 Castle 少采集
  wasDiscarded: false,
  prerendering: false,
  fullscreenElement: null,
  webkitHidden: false,
  onbeforematch: null,
  currentScript: null,
  caretPositionFromPoint() { return null; },
  // 实抓：documentMode（IE 专有）/ mozFullScreen（Firefox 专有）在 Chrome 上就是 undefined，不定义
  // documentElement 在 fakeDocument 之后用 makeElement 补成完整元素（见下方）
  location: fakeLocation,
  querySelector() { return null; },
  querySelectorAll(selector) {
    const sel = String(selector || '');
    // Castle 的 x-web UMD 会额外查询 script 与媒体/脚本集合；返回同一批
    // 脚本壳，避免把“有脚本但 querySelectorAll 为空”伪造成非浏览器。
    if (sel === 'img, style, script, p' && _QUERY_ELEMENTS.length) return _QUERY_ELEMENTS;
    if (sel === '*') return _ALL_ELEMENTS_ENABLED ? _ALL_ELEMENTS : [];
    if (sel === 'script' || sel === 'img, style, script, p') return this.scripts || [];
    return [];
  },
  getElementsByTagName() { return []; },
  getElementById() { return null; },
  createElement(tag) { return makeElement(tag); },
  createElementNS(ns, tag) { return makeElement(tag); },
  addEventListener(type, fn) { _addEvent(_eventBuckets.document, type, fn); },
  removeEventListener(type, fn) { _removeEvent(_eventBuckets.document, type, fn); },
  dispatchEvent(ev) { if (ev && ev.type) _dispatchEvent(_eventBuckets.document, ev.type, ev); return true; },
  createEvent() { return { initEvent() {} }; },
  fonts: { ready: Promise.resolve(), status: 'loaded', check: () => true, load: () => Promise.resolve([]), values: () => [][Symbol.iterator](), forEach() {}, size: 0, addEventListener() {} },
  hasStorageAccess: () => Promise.resolve(false),
  requestStorageAccess: () => Promise.resolve(),
};
// body / documentElement 必须在 document 之后挂（实抓：真实页面它们是完整元素，
// 只给 {style,lang,clientWidth} 那种壳会让 webdriver 检测读 attributes 时炸掉）
fakeDocument.body = makeElement('body');
fakeDocument.head = makeElement('head');
fakeDocument.documentElement = Object.assign(makeElement('html'), {
  // 当前实际登录页的 <html lang="zh">；页面语言会进入 document 元数据指纹。
  lang: process.env.CASTLE_LANG || 'zh', clientWidth: 1297, clientHeight: 800,
  scrollWidth: 1297, scrollHeight: 800, scrollTop: 0, scrollLeft: 0,
  offsetWidth: 1282, offsetHeight: 800,
});
fakeDocument.body.isConnected = true;
if (process.env.CASTLE_DOC_TRACE) {
  const _traceBody = fakeDocument.body, _traceHtml = fakeDocument.documentElement, _traceSheets = fakeDocument.styleSheets;
  Object.defineProperty(fakeDocument, 'body', { configurable: true, get() { console.log('DOC_GET body'); return _traceBody; } });
  Object.defineProperty(fakeDocument, 'documentElement', { configurable: true, get() { console.log('DOC_GET documentElement'); return _traceHtml; } });
  Object.defineProperty(fakeDocument, 'styleSheets', { configurable: true, get() { console.log('DOC_GET styleSheets'); return _traceSheets; } });
}
// clean onboarding 文档实抓：body 被滚动条占去 15px，宽度 1282；
// documentElement / visualViewport 仍是 1297×800。
fakeDocument.body.clientWidth = 1282; fakeDocument.body.clientHeight = 800;
fakeDocument.body.scrollWidth = 1282; fakeDocument.body.scrollHeight = 800;
fakeDocument.body.offsetWidth = 1282; fakeDocument.body.offsetHeight = 800;
fakeDocument.body.getClientRects = () => [{ x: 0, y: 0, width: 1282, height: 800, top: 0, left: 0, right: 1282, bottom: 800 }];
fakeDocument.documentElement.isConnected = true;
if (process.env.CASTLE_NO_LANG === '1') delete fakeDocument.documentElement.lang;
fakeDocument.documentElement.getClientRects = () => [{ x: 0, y: 0, width: 1282, height: 800, top: 0, left: 0, right: 1282, bottom: 800 }];
if (process.env.CASTLE_DISABLE_RECTS === '1') {
  fakeDocument.body.getClientRects = () => [];
  fakeDocument.documentElement.getClientRects = () => [];
}
// 当前 x.com 文档中 Castle 枚举到的 collection 规模与脚本/CSS 形状。
// 它会读取 textContent、attributes.length 与 cssRules.length，空对象会
// 让这一整组信号缺席。
const _SCRIPT_META_DEFAULT =   [
    [
      0,
      3,
      "https://accounts.google.com/gsi/client"
    ],
    [
      0,
      3,
      "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js"
    ],
    [
      494,
      1,
      ""
    ],
    [
      184418,
      3,
      ""
    ],
    [
      0,
      2,
      ""
    ],
    [
      75986,
      3,
      ""
    ],
    [
      77,
      3,
      ""
    ],
    [
      251,
      3,
      ""
    ],
    [
      0,
      5,
      "https://x.com/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload"
    ],
    [
      0,
      6,
      "https://abs.twimg.com/responsive-web/client-web/vendor.468337bb351e1ee9a.js"
    ],
    [
      0,
      6,
      "https://abs.twimg.com/responsive-web/client-web/i18n/zh.0434ed0af43eb437a.js"
    ],
    [
      0,
      6,
      "https://abs.twimg.com/responsive-web/client-web/main.60bedca26c9a9faaa.js"
    ],
    [
      1368,
      1,
      ""
    ],
    [
      0,
      4,
      "https://accounts.google.com/gsi/client"
    ]
  ];
const _SCRIPT_META = (() => {
  const raw = process.env.CASTLE_SCRIPTS_JSON_B64;
  if (!raw) return _SCRIPT_META_DEFAULT;
  try {
    const v = JSON.parse(_Buffer.from(raw, 'base64').toString('utf8'));
    return Array.isArray(v) ? v : _SCRIPT_META_DEFAULT;
  } catch (e) { return _SCRIPT_META_DEFAULT; }
})();
// Castle hashes script text with its embedded Murmur3 (jo/Ja).  Supplying the
// captured hash preimages keeps the signal exact without copying the inline
// application bundle into this file.
const _SCRIPT_TEXT_HASHES_DEFAULT = [0, 3968346828, 1769322018, 0, 3950670401, 607148723, 118777331, 0, 0, 0, 0, 311287422, 0];
const _SCRIPT_TEXT_HASHES = (() => {
  const raw = process.env.CASTLE_SCRIPT_TEXT_HASHES_B64;
  if (!raw) return _SCRIPT_TEXT_HASHES_DEFAULT;
  try {
    const v = JSON.parse(_Buffer.from(raw, 'base64').toString('utf8'));
    return Array.isArray(v) ? v : _SCRIPT_TEXT_HASHES_DEFAULT;
  } catch (e) { return _SCRIPT_TEXT_HASHES_DEFAULT; }
})();
function _u32(v) { return v >>> 0; }
function _rotl32(v, n) { return _u32((v << n) | (v >>> (32 - n))); }
function _rotr32(v, n) { return _u32((v >>> n) | (v << (32 - n))); }
function _unxorshr(v, n) {
  v = _u32(v ^ (v >>> n));
  if (2 * n < 32) v = _u32(v ^ (v >>> (2 * n)));
  if (4 * n < 32) v = _u32(v ^ (v >>> (4 * n)));
  return v;
}
function _invOdd32(a) {
  let x = a >>> 0;
  for (let i = 0; i < 5; i++) x = Math.imul(x, _u32(2 - Math.imul(a, x)));
  return x >>> 0;
}
const _INV_C1 = _invOdd32(0xcc9e2d51), _INV_C2 = _invOdd32(0x1b873593), _INV_C5 = _invOdd32(5);
function _murmur4Preimage(hash) {
  let h = _u32(hash);
  h = _unxorshr(h, 16); h = Math.imul(h, _invOdd32(0xc2b2ae35));
  h = _unxorshr(h, 13); h = Math.imul(h, _invOdd32(0x85ebca6b));
  h = _unxorshr(h, 16); h = _u32(h ^ 4);
  h = Math.imul(_u32(h - 0xe6546b64), _INV_C5); h = _rotr32(h, 13);
  h = Math.imul(h, _INV_C2); h = _rotr32(h, 15); h = Math.imul(h, _INV_C1);
  return String.fromCharCode(h & 255, (h >>> 8) & 255, (h >>> 16) & 255, h >>> 24);
}
const _SCRIPT_HASH_PREIMAGE = String(process.env.CASTLE_SCRIPT_HASH_PREIMAGE || '') === '1';
fakeDocument.scripts = _SCRIPT_META.map(([textLen, attrs, src], i) => ({
  tagName: 'SCRIPT', nodeName: 'SCRIPT', childElementCount: 0,
  src: src || '', href: '', textContent: _SCRIPT_HASH_PREIMAGE
    ? _murmur4Preimage(Number(_SCRIPT_TEXT_HASHES[i] || 0) >>> 0)
    : 'x'.repeat(Number(textLen) || 0),
  attributes: { length: Number(attrs) || 0 },
}));
if (process.env.CASTLE_DISABLE_SCRIPTS === '1') fakeDocument.scripts = null;
if (process.env.CASTLE_SCRIPT_DEBUG) {
  fakeDocument.scripts = fakeDocument.scripts.map((el, i) => new Proxy(el, { get(o, p) {
    if (['src', 'textContent', 'attributes'].includes(String(p))) console.log('SCRIPT_GET', i, String(p), String(o[p]).slice(0, 24), o[p] && o[p].length);
    return o[p];
  }}));
}
// 登录表单聚焦并提交前，jetfuel 动态样式表会变为 148 条规则；
// Castle 在 begin_login 前采集的是这个已交互状态（而非初始 145）。
const _STYLE_RULE_COUNTS_DEFAULT = [4, 5, 1, 6, 2, 727, 544, 1, 148, 81, null, 4, 4];
const _STYLE_RULE_COUNTS = (() => {
  const raw = process.env.CASTLE_STYLE_COUNTS_B64;
  if (!raw) return _STYLE_RULE_COUNTS_DEFAULT;
  try { const v = JSON.parse(_Buffer.from(raw, 'base64').toString('utf8')); return Array.isArray(v) ? v : _STYLE_RULE_COUNTS_DEFAULT; }
  catch (e) { return _STYLE_RULE_COUNTS_DEFAULT; }
})();
function CSSStyleRule() {}
function CSSFontFaceRule() {}
function CSSKeyframesRule() {}
// 在真实 Chromium 中这些宿主构造器的 Function#toString 是 native code；
// Castle 会把 rule.constructor 继续当作值采集。覆盖自有 toString，避免
// Node 的 `function CSSStyleRule(){}` 文本泄露到指纹序列化中。
for (const _ctor of [CSSStyleRule, CSSFontFaceRule, CSSKeyframesRule]) {
  const _name = _ctor.name;
  _ctor.toString = () => `function ${_name}() { [native code] }`;
}
const _STYLE_FIRST = [
  ['input::placeholder { user-select: none; }', 'input::placeholder', 1],
  ['@font-face { font-family: Vazirmatn; src: url("https://abs.twimg.com/responsive-web/client-web/Vazirmatn-Light.a929468a.woff2") format("woff2"); font-weight: 300; font-style: normal; font-display: swap; }', null, 5],
  ['@font-face { font-family: Geist; src: url("https://abs.twimg.com/responsive-web/client-web/Geist-var.2587a0ca.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }', null, 5],
  ['@font-face { font-family: TwitterChirp; src: url("https://abs.twimg.com/responsive-web/client-web/Chirp-Light.3a18e64a.woff2") format("woff2"), url("https://abs.twimg.com/responsive-web/client-web/Chirp-Light.7a5673aa.woff") format("woff"); font-weight: 300; font-style: normal; font-display: swap; }', null, 5],
  ['html, body { height: 100%; }', 'html, body', 1], ['[stylesheet-group="0"] { }', '[stylesheet-group="0"]', 0],
  ['.jetfuel-style-root { --tw-translate-x: 0; --tw-translate-y: 0; --tw-rotate: 0; --tw-skew-x: 0; --tw-skew-y: 0; --tw-scale-x: 1; --tw-scale-y: 1; --tw-gradient-from-position: ; --tw-gradient-to-position: ; --tw-blur: ; --tw-brightness: ; --tw-contrast: ; --tw-grayscale: ; --tw-hue-rotate: ; --tw-invert: ; --tw-saturate: ; --tw-sepia: ; --tw-drop-shadow: ; --tw-backdrop-blur: ; --tw-backdrop-brightness: ; --tw-backdrop-contrast: ; --tw-backdrop-grayscale: ; --tw-backdrop-hue-rotate: ; --tw-backdrop-invert: ; --tw-backdrop-opacity: ; --tw-backdrop-saturate: ; --tw-backdrop-sepia: ; font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif; }', '.jetfuel-style-root', 28],
  ['input.jf-element, textarea.jf-element { background-color: transparent; }', 'input.jf-element, textarea.jf-element', 1],
  ['.jetfuel-style-root .j-brlc3d0 { margin-bottom: -1px; }', '.jetfuel-style-root .j-brlc3d0', 1],
  ['.qJTHM { user-select: none; color: rgb(32, 33, 36); direction: ltr; font-family: Roboto-Regular, arial, sans-serif; -webkit-font-smoothing: antialiased; font-weight: 400; margin: 0px; overflow: hidden; text-size-adjust: 100%; }', '.qJTHM', 13], null,
  ['@keyframes slideUp { \n  0% { bottom: 0px; opacity: 0; }\n  100% { bottom: 1rem; opacity: 1; }\n}', null, null], ['@keyframes slideUp { \n  0% { bottom: 0px; opacity: 0; }\n  100% { bottom: 1rem; opacity: 1; }\n}', null, null],
];
fakeDocument.styleSheets = _STYLE_RULE_COUNTS.map((n, i) => {
  if (process.env.CASTLE_STYLE_DEBUG) console.log('STYLE_COUNT_INIT', i, n);
  const first = _STYLE_FIRST[i] || (i === 10 && String(process.env.CASTLE_STYLE_FORCE10 || '') === '1' ? _STYLE_FIRST[11] : null);
  const isKeyframes = i === 11 || i === 12;
  const isFontFace = i === 1 || i === 2 || i === 3;
  const ruleCtor = isKeyframes ? CSSKeyframesRule : (isFontFace ? CSSFontFaceRule : CSSStyleRule);
  const ruleTag = isKeyframes ? 'CSSKeyframesRule' : (isFontFace ? 'CSSFontFaceRule' : 'CSSStyleRule');
  const firstRuleBase = first ? { constructor: ruleCtor, [Symbol.toStringTag]: ruleTag, cssText: String(first[0] || ''), ...(first[1] == null ? {} : { selectorText: first[1] }), ...(first[2] == null ? {} : { style: { length: first[2] } }) } : null;
  const firstRule = firstRuleBase && process.env.CASTLE_STYLE_DEBUG ? new Proxy(firstRuleBase, { get(o, p) { const v=o[p]; console.log('STYLE_RULE_GET', i, String(p), typeof v === 'string' ? v.length : (v && v.length)); return v; } }) : firstRuleBase;
  if (n === null && String(process.env.CASTLE_STYLE_SECURITY_EMPTY || '') !== '1') return { get cssRules() {
    if (typeof DOMException === 'function') throw new DOMException('', 'SecurityError');
    throw new Error('SecurityError');
  } };
  if (n === null) n = 0;
  const rules = { [Symbol.toStringTag]: 'CSSRuleList', length: n, item: (j) => j === 0 ? firstRule : null };
  if (process.env.CASTLE_STYLE_DEBUG) Object.defineProperty(rules, 'length', { configurable: true, get() { console.log('STYLE_LENGTH', i, n); return n; } });
  if (firstRule) rules[0] = firstRule;
  return { [Symbol.toStringTag]: 'CSSStyleSheet', cssRules: rules };
});
if (String(process.env.CASTLE_STYLE_SKIP_SECURITY || '1') === '1') {
  fakeDocument.styleSheets = fakeDocument.styleSheets.filter((_, i) => _STYLE_RULE_COUNTS[i] !== null);
}
if (String(process.env.CASTLE_STYLE_EXTRA_EMPTY || '') === '1') {
  fakeDocument.styleSheets.push({ [Symbol.toStringTag]: 'CSSStyleSheet', cssRules: { length: 0, item() { return null; } } });
}
if (process.env.CASTLE_DISABLE_STYLES === '1') fakeDocument.styleSheets = null;

const _subtle = nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle;
const _subtleLog = [];
const fakeCrypto = {
  getRandomValues(arr) { fakeCrypto._rng++; nodeCrypto.randomFillSync(_Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)); return arr; },
  randomUUID() { return nodeCrypto.randomUUID(); },
  subtle: _subtle ? new Proxy(_subtle, { get(o, p) { const v = o[p]; if (typeof v === 'function') return (...a) => { _subtleLog.push(String(p)); return v.apply(o, a); }; return v; } }) : undefined,
  _rng: 0,
};

// ---------- 网络存根：不联网（也避免 undici 触到被隐藏的 Buffer）----------
function fakeResponse(body) {
  body = body || '';
  return {
    ok: true, status: 200, statusText: 'OK', type: 'basic', url: '', redirected: false,
    headers: { get() { return null; }, has() { return false; }, forEach() {} },
    clone() { return fakeResponse(body); },
    text() { return Promise.resolve(String(body)); },
    json() { return Promise.resolve({}); },
    arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); },
    blob() { return Promise.resolve({}); },
  };
}
const fakeFetch = (url, opts) => { fakeFetch._log.push({ url: String(url), opts }); return Promise.resolve(fakeResponse('')); };
fakeFetch._log = [];

function FakeXHR() {
  this.readyState = 0; this.status = 0; this.response = ''; this.responseText = '';
  this._headers = {};
}
FakeXHR.prototype.open = function (m, u) { this._method = m; this._url = u; this.readyState = 1; };
FakeXHR.prototype.setRequestHeader = function (k, v) { this._headers[k] = v; };
FakeXHR.prototype.addEventListener = function (ev, cb) { (this['_on_' + ev] || (this['_on_' + ev] = [])).push(cb); };
FakeXHR.prototype.removeEventListener = function () {};
FakeXHR.prototype.getAllResponseHeaders = function () { return ''; };
FakeXHR.prototype.getResponseHeader = function () { return null; };
FakeXHR.prototype.send = function (body) {
  FakeXHR._log.push({ url: this._url, method: this._method, body });
  this.readyState = 4; this.status = 200; this.response = ''; this.responseText = '';
  const fire = (ev) => { if (typeof this['on' + ev] === 'function') this['on' + ev]({ type: ev }); (this['_on_' + ev] || []).forEach((c) => c({ type: ev })); };
  setTimeout(() => { fire('readystatechange'); fire('load'); fire('loadend'); }, 0);
};
FakeXHR.prototype.abort = function () {};
FakeXHR._log = [];

function FakeWebSocket() { this.readyState = 3; }
FakeWebSocket.prototype.send = function () {};
FakeWebSocket.prototype.close = function () {};
FakeWebSocket.prototype.addEventListener = function () {};

// ---------- Worker / Blob / OffscreenCanvas 存根（信号采集用）----------
const _blobStore = new Map();
let _blobSeq = 0;
function FakeBlob(parts, opts) {
  this._parts = parts || [];
  this.type = (opts && opts.type) || '';
  // Current Castle chunk compressor uses `new Blob([Uint8Array]).stream()` when the
  // browser CompressionStream API is present.  The old stub only retained
  // string parts, so `.stream()` was missing and Castle silently fell back to
  // its larger custom deflater.  Preserve both text and byte parts and expose
  // a real ReadableStream so Node's native CompressionStream follows Chrome's
  // deflate-raw path.
  try {
    const chunks = this._parts.map((p) => {
      if (typeof p === 'string') return _Buffer.from(p);
      if (p instanceof ArrayBuffer) return _Buffer.from(new Uint8Array(p));
      if (ArrayBuffer.isView(p)) return _Buffer.from(p.buffer, p.byteOffset, p.byteLength);
      return _Buffer.from(String(p));
    });
    this._bytes = _Buffer.concat(chunks);
    this._text = this._bytes.toString('utf8');
    // Temporary parity probe: the Castle deflate-raw path receives the exact
    // signal frame as a Uint8Array Blob.  Keep an opt-in copy for one run so
    // browser/local frames can be compared without changing production output.
    if (_process && _process.env && _process.env.CASTLE_COMPRESS_INPUT_FILE && this._bytes.length >= 1000) {
      try { _fs.writeFileSync(_process.env.CASTLE_COMPRESS_INPUT_FILE, this._bytes); } catch (e) {}
    }
    if (_process && _process.env && _process.env.CASTLE_COMPRESS_STACK && this._bytes.length >= 1000) {
      try { _fs.writeFileSync(_process.env.CASTLE_COMPRESS_STACK, String(new Error().stack || '')); } catch (e) {}
    }
  } catch { this._bytes = _Buffer.alloc(0); this._text = ''; }
  this.size = this._bytes.length;
}
FakeBlob.prototype.text = function () { return Promise.resolve(this._text); };
FakeBlob.prototype.arrayBuffer = function () {
  const out = new Uint8Array(this._bytes);
  return Promise.resolve(out.buffer);
};
FakeBlob.prototype.stream = function () {
  const bytes = new Uint8Array(this._bytes);
  if (typeof ReadableStream !== 'function') return null;
  return new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
};
FakeBlob.prototype.slice = function (start = 0, end = this.size, type = this.type) {
  return new FakeBlob([this._bytes.slice(start, end)], { type });
};

const fakeURL = {
  createObjectURL(blob) { const u = 'blob:x.com/' + (_blobSeq++); _blobStore.set(u, blob); return u; },
  revokeObjectURL(u) { _blobStore.delete(u); },
};

function FakeOffscreenCanvas(w, h) { this.width = w; this.height = h; }
FakeOffscreenCanvas.prototype.getContext = function (type) {
  if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
    const UNMASKED_VENDOR_WEBGL = 37445, UNMASKED_RENDERER_WEBGL = 37446;
    return {
      UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL,
      getExtension(name) {
        if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL };
        return null;
      },
      getParameter(p) {
        if (p === UNMASKED_VENDOR_WEBGL) return 'Google Inc. (NVIDIA)';
        if (p === UNMASKED_RENDERER_WEBGL) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Ti (0x00002D04) Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return null;
      },
    };
  }
  return null;
};

// ---------- 指纹相关的异步 API 存根（很多信号收集器靠这些回调 resolve）----------
function _audioParam(v) { return { value: v || 0, setValueAtTime() {}, setTargetAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }; }
function _audioNode() { return { connect() { return _audioNode(); }, disconnect() {}, start() {}, stop() {} }; }
function FakeOfflineAudioContext(ch, len, rate) { this.sampleRate = rate || 44100; this.length = len || 44100; this.destination = _audioNode(); this.currentTime = 0; this.oncomplete = null; }
FakeOfflineAudioContext.prototype.createOscillator = function () { const n = _audioNode(); n.frequency = _audioParam(440); n.type = 'sine'; return n; };
FakeOfflineAudioContext.prototype.createDynamicsCompressor = function () { const n = _audioNode(); n.threshold = _audioParam(-50); n.knee = _audioParam(40); n.ratio = _audioParam(12); n.attack = _audioParam(0); n.release = _audioParam(0.25); n.reduction = 0; return n; };
FakeOfflineAudioContext.prototype.createGain = function () { const n = _audioNode(); n.gain = _audioParam(1); return n; };
FakeOfflineAudioContext.prototype.createBufferSource = function () { const n = _audioNode(); n.buffer = null; return n; };
FakeOfflineAudioContext.prototype.createAnalyser = function () { const n = _audioNode(); n.frequencyBinCount = 1024; n.getFloatFrequencyData = function () {}; return n; };
FakeOfflineAudioContext.prototype.startRendering = function () {
  const self = this;
  const buf = { length: self.length, numberOfChannels: 1, sampleRate: self.sampleRate, duration: self.length / self.sampleRate, getChannelData: () => new Float32Array(self.length), copyFromChannel() {} };
  if (self.oncomplete) setTimeout(() => self.oncomplete({ renderedBuffer: buf }), 0);
  return _RealPromise.resolve(buf);
};
function FakeAudioContext() { FakeOfflineAudioContext.call(this, 1, 44100, 44100); this.state = 'suspended'; }
FakeAudioContext.prototype = Object.create(FakeOfflineAudioContext.prototype);
FakeAudioContext.prototype.close = function () { return _RealPromise.resolve(); };
FakeAudioContext.prototype.resume = function () { return _RealPromise.resolve(); };
FakeAudioContext.prototype.createMediaStreamDestination = function () { return _audioNode(); };

// ---------- WebRTC ----------
// Castle 的信号 380 走这条链：createOffer → 用正则从 SDP 里扒传输协议
// （UDP/TLS/RTP/SAVPF、DTLS/SCTP、UDP）+ 收集 onicecandidate 的候选，凑成列表后 **sort**，
// 记录正是在 sort 的比较器里产出的——列表不足 2 项比较器就不跑，信号整条缺席。
// 所以 offer 的 SDP 必须是真 Chrome 的形状，ICE 候选也要真发几条。
// 只发 mDNS（.local）host 候选：真实 Chrome 默认就是这样，且不会暴露一个与出口 IP
// 对不上的假 srflx 地址（那反而是破绽）。
const _rtcRand = (n, alphabet) => {
  const a = alphabet || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = '';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};
const _rtcHex = (n) => _rtcRand(n, '0123456789ABCDEF');
const _rtcFingerprint = () => Array.from({ length: 32 }, () => _rtcHex(2)).join(':');
const _rtcMdns = () => `${_rtcRand(8, '0123456789abcdef')}-${_rtcRand(4, '0123456789abcdef')}-4${_rtcRand(3, '0123456789abcdef')}-a${_rtcRand(3, '0123456789abcdef')}-${_rtcRand(12, '0123456789abcdef')}.local`;

function FakeRTCPeerConnection() {
  this.onicecandidate = null; this.onicegatheringstatechange = null;
  this.oniceconnectionstatechange = null; this.onsignalingstatechange = null;
  this.onconnectionstatechange = null; this.ondatachannel = null; this.ontrack = null;
  this.iceGatheringState = 'new'; this.iceConnectionState = 'new';
  this.signalingState = 'stable'; this.connectionState = 'new';
  this.localDescription = null; this.remoteDescription = null;
  this.currentLocalDescription = null; this.pendingLocalDescription = null;
  this.canTrickleIceCandidates = null;
  this._ufrag = _rtcRand(4); this._pwd = _rtcRand(22);
  this._fp = _rtcFingerprint(); this._mdns = _rtcMdns();
  this._sess = String(Math.floor(Math.random() * 9e18) + 1e18);
  this._closed = false;
}
FakeRTCPeerConnection.prototype.createDataChannel = function () {
  return { label: '', ordered: true, readyState: 'connecting', send() {}, close() {}, addEventListener() {} };
};
FakeRTCPeerConnection.prototype.createOffer = function () {
  const u = this._ufrag, p = this._pwd, f = this._fp;
  const sdp = [
    'v=0',
    `o=- ${this._sess} 2 IN IP4 127.0.0.1`,
    's=-', 't=0 0',
    'a=group:BUNDLE 0 1',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${u}`, `a=ice-pwd:${p}`, 'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${f}`, 'a=setup:actpass', 'a=mid:0',
    'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=recvonly', 'a=rtcp-mux', 'a=rtcp-rsize',
    'a=rtpmap:111 opus/48000/2', 'a=rtcp-fb:111 transport-cc',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:63 red/48000/2', 'a=fmtp:63 111/111',
    'a=rtpmap:9 G722/8000', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000',
    'a=rtpmap:13 CN/8000', 'a=rtpmap:110 telephone-event/48000',
    'a=rtpmap:126 telephone-event/8000',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${u}`, `a=ice-pwd:${p}`, 'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${f}`, 'a=setup:actpass', 'a=mid:1',
    'a=sctp-port:5000', 'a=max-message-size:262144', '',
  ].join('\r\n');
  return _RealPromise.resolve({ type: 'offer', sdp });
};
FakeRTCPeerConnection.prototype.setLocalDescription = function (d) {
  const self = this;
  self.localDescription = d || null;
  self.currentLocalDescription = self.localDescription;
  self.signalingState = 'have-local-offer';
  const fire = (name, arg) => { if (typeof self['on' + name] === 'function') { try { self['on' + name](arg || { type: name }); } catch (e) {} } };
  const cand = (mid, idx, foundation, prio, port) => ({
    candidate: `candidate:${foundation} 1 udp ${prio} ${self._mdns} ${port} typ host generation 0 ufrag ${self._ufrag} network-cost 999`,
    sdpMid: String(mid), sdpMLineIndex: idx, foundation: String(foundation),
    component: 'rtp', priority: prio, address: self._mdns, protocol: 'udp',
    port, type: 'host', tcpType: '', relatedAddress: null, relatedPort: null,
    usernameFragment: self._ufrag,
  });
  setTimeout(() => {
    if (self._closed) return;
    fire('signalingstatechange');
    self.iceGatheringState = 'gathering';
    fire('icegatheringstatechange');
    const base = 50000 + Math.floor(Math.random() * 10000);
    fire('icecandidate', { candidate: cand(0, 0, 842163049, 2113937151, base) });
    fire('icecandidate', { candidate: cand(1, 1, 842163049, 2113937151, base + 1) });
    self.iceConnectionState = 'checking';
    fire('iceconnectionstatechange');
    self.iceGatheringState = 'complete';
    fire('icecandidate', { candidate: null });
    fire('icegatheringstatechange');
  }, 1);
  return _RealPromise.resolve();
};
FakeRTCPeerConnection.prototype.setRemoteDescription = function () { return _RealPromise.resolve(); };
FakeRTCPeerConnection.prototype.addTransceiver = function () { return { sender: {}, receiver: {} }; };
FakeRTCPeerConnection.prototype.getStats = function () { return _RealPromise.resolve(new Map()); };
FakeRTCPeerConnection.prototype.close = function () { this._closed = true; this.signalingState = 'closed'; this.iceConnectionState = 'closed'; this.connectionState = 'closed'; };
FakeRTCPeerConnection.prototype.addEventListener = function (ev, cb) { this['on' + ev] = cb; };
FakeRTCPeerConnection.prototype.removeEventListener = function (ev) { this['on' + ev] = null; };

const fakeMatchMedia = (q) => ({ matches: false, media: String(q || ''), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
const fakeSpeechSynthesis = { getVoices: () => [], speak() {}, cancel() {}, pause() {}, resume() {}, pending: false, speaking: false, paused: false, onvoiceschanged: null, addEventListener() {}, removeEventListener() {} };

// ---------- Worker：真正在进程内执行 worker 源码，双向投递消息 ----------
function makeWorker(kind, deps) {
  function W(url) {
    this._url = String(url);
    const blob = _blobStore.get(this._url);
    this._src = blob;
    this.onmessage = null; this.onerror = null; this.onmessageerror = null;
    this._listeners = {};
    W._instances.push(this);

    const self = this;
    const scope = {
      onmessage: null,
      navigator: deps.navigator,
      OffscreenCanvas: deps.OffscreenCanvas,
      performance: deps.performance,
      Date, Array, Object, JSON, Promise, Math, console,
      postMessage(msg) { self._toMain(msg); },
      addEventListener(ev, cb) { if (ev === 'message') scope.onmessage = cb; },
    };
    scope.self = scope;
    this._scope = scope;

    const src = (blob && blob._text) || '';
    if (src) {
      try {
        const fn = new Function('self', 'navigator', 'OffscreenCanvas', 'performance',
          'postMessage', 'Date', 'Array', 'Object', 'JSON', 'Promise', 'Math', 'console',
          src);
        fn(scope, scope.navigator, scope.OffscreenCanvas, scope.performance,
          scope.postMessage, Date, Array, Object, JSON, Promise, Math, console);
      } catch (e) { W._errors.push(String(e)); }
    }
  }
  W.prototype._toMain = function (msg) {
    const ev = { data: msg, type: 'message' };
    const tag = Array.isArray(msg) ? msg[0] : '?';
    W._mainReceived.push({ tag, hadHandler: typeof this.onmessage === 'function', listeners: (this._listeners.message || []).length });
    setTimeout(() => {
      try { if (typeof this.onmessage === 'function') this.onmessage(ev); } catch (e) { W._errors.push('main onmessage: ' + e); }
      (this._listeners.message || []).forEach((c) => { try { c(ev); } catch (e) { W._errors.push('main listener: ' + e); } });
    }, 0);
  };
  W.prototype.postMessage = function (msg) {
    W._posts.push({ url: this._url, msg: typeof msg });
    const ev = { data: msg, type: 'message' };
    const h = this._scope && this._scope.onmessage;
    setTimeout(() => { try { if (typeof h === 'function') h(ev); } catch (e) { W._errors.push('worker onmessage: ' + e); } }, 0);
  };
  W.prototype.terminate = function () {};
  W.prototype.addEventListener = function (ev, cb) { (this._listeners[ev] || (this._listeners[ev] = [])).push(cb); };
  W.prototype.removeEventListener = function () {};
  W.prototype.close = function () {};
  W._instances = []; W._posts = []; W._errors = []; W._mainReceived = [];
  W._kind = kind;
  return W;
}
const FakeWorker = makeWorker('dedicated', {
  navigator: fakeNavigator, OffscreenCanvas: FakeOffscreenCanvas,
  performance: { now: () => Number(_hrtimeBig() / 1000n) / 1000 },
});

// SharedWorker：捕获源码 + 端口双向投递（tag-2 信号收集器）
const _sharedDeps = { navigator: fakeNavigator, OffscreenCanvas: FakeOffscreenCanvas, performance: { now: () => Number(_hrtimeBig() / 1000n) / 1000 } };
function FakeSharedWorker(url) {
  this._url = String(url);
  const blob = _blobStore.get(this._url);
  this._src = blob;
  FakeSharedWorker._instances.push(this);

  const mainPort = { onmessage: null, _listeners: [], start() {}, close() {},
    addEventListener(ev, cb) { if (ev === 'message') this._listeners.push(cb); },
    removeEventListener() {},
    postMessage(msg) { setTimeout(() => { const ev = { data: msg }; if (typeof workerPort.onmessage === 'function') workerPort.onmessage(ev); (workerPort._listeners || []).forEach((c) => c(ev)); }, 0); },
  };
  const workerPort = { onmessage: null, _listeners: [], start() {}, close() {},
    addEventListener(ev, cb) { if (ev === 'message') this._listeners.push(cb); },
    postMessage(msg) { FakeSharedWorker._mainReceived.push(Array.isArray(msg) ? msg[0] : '?'); setTimeout(() => { const ev = { data: msg }; if (typeof mainPort.onmessage === 'function') mainPort.onmessage(ev); (mainPort._listeners || []).forEach((c) => c(ev)); }, 0); },
  };
  this.port = mainPort;

  const src = (blob && blob._text) || '';
  if (src) {
    const scope = { onconnect: null, onmessage: null,
      navigator: _sharedDeps.navigator, OffscreenCanvas: _sharedDeps.OffscreenCanvas, performance: _sharedDeps.performance,
      Date, Array, Object, JSON, Promise, Math, console,
      postMessage(msg) { workerPort.postMessage(msg); },
      addEventListener(ev, cb) { if (ev === 'connect') scope.onconnect = cb; if (ev === 'message') scope.onmessage = cb; },
    };
    scope.self = scope;
    try {
      const fn = new Function('self', 'navigator', 'OffscreenCanvas', 'performance', 'postMessage', 'Date', 'Array', 'Object', 'JSON', 'Promise', 'Math', 'console', src);
      fn(scope, scope.navigator, scope.OffscreenCanvas, scope.performance, scope.postMessage, Date, Array, Object, JSON, Promise, Math, console);
    } catch (e) { FakeSharedWorker._errors.push(String(e)); }
    // 触发 onconnect，传入 workerPort
    setTimeout(() => { try { if (typeof scope.onconnect === 'function') scope.onconnect({ ports: [workerPort], source: workerPort }); } catch (e) { FakeSharedWorker._errors.push('onconnect: ' + e); } }, 0);
  }
}
FakeSharedWorker._instances = []; FakeSharedWorker._errors = []; FakeSharedWorker._mainReceived = [];

// Chrome exposes Performance/PerformanceEntry as prototype-backed Web API
// objects.  A plain object with enumerable fields looks superficially similar
// but Castle's property classifier can distinguish it (and then skips the
// navigation/mark timing branch).  Keep the same prototype/own-key shape and
// return the small set of entries observed on the login page.
function _nativeCtor(name) {
  const C = function () {};
  try { env.setFuncNative(C, name, 0); } catch (e) {
    try { Object.defineProperty(C, 'name', { value: name, configurable: true }); } catch (x) {}
  }
  return C;
}
function _defineNativeProto(C, name, defs) {
  const proto = C.prototype;
  Object.defineProperty(proto, 'constructor', { value: C, enumerable: false, configurable: true, writable: true });
  for (const [k, d] of Object.entries(defs || {})) {
    Object.defineProperty(proto, k, typeof d === 'object' && (d.get || d.value !== undefined)
      ? Object.assign({ enumerable: true, configurable: true }, d)
      : { value: d, enumerable: true, configurable: true, writable: true });
  }
  return proto;
}
const _PerfEntryCtor = _nativeCtor('PerformanceEntry');
_defineNativeProto(_PerfEntryCtor, 'PerformanceEntry', {
  name: { get() { return this._name; } },
  entryType: { get() { return this._entryType; } },
  startTime: { get() { return this._startTime; } },
  duration: { get() { return this._duration; } },
  toJSON() { return {}; },
  navigationId: { get() { return ''; } },
});
const _PerfResourceCtor = _nativeCtor('PerformanceResourceTiming');
_PerfResourceCtor.prototype = Object.create(_PerfEntryCtor.prototype);
_defineNativeProto(_PerfResourceCtor, 'PerformanceResourceTiming', {
  initiatorType: { get() { return ''; } }, nextHopProtocol: { get() { return ''; } },
  deliveryType: { get() { return ''; } }, workerStart: { get() { return 0; } },
  redirectStart: { get() { return 0; } }, redirectEnd: { get() { return 0; } },
  fetchStart: { get() { return 0; } }, domainLookupStart: { get() { return 0; } },
  domainLookupEnd: { get() { return 0; } }, connectStart: { get() { return 0; } },
  connectEnd: { get() { return 0; } }, secureConnectionStart: { get() { return 0; } },
  requestStart: { get() { return 0; } }, responseStart: { get() { return 0; } },
  responseEnd: { get() { return 0; } }, transferSize: { get() { return 0; } },
  encodedBodySize: { get() { return 0; } }, decodedBodySize: { get() { return 0; } },
  serverTiming: { get() { return []; } }, renderBlockingStatus: { get() { return 'non-blocking'; } },
  responseStatus: { get() { return 200; } }, contentType: { get() { return ''; } },
  contentEncoding: { get() { return ''; } }, finalResponseHeadersStart: { get() { return 0; } },
  firstInterimResponseStart: { get() { return 0; } }, toJSON() { return {}; },
  workerRouterEvaluationStart: { get() { return 0; } }, workerCacheLookupStart: { get() { return 0; } },
  workerMatchedSourceType: { get() { return ''; } }, workerFinalSourceType: { get() { return ''; } },
});
const _PerfNavCtor = _nativeCtor('PerformanceNavigationTiming');
_PerfNavCtor.prototype = Object.create(_PerfResourceCtor.prototype);
const _navDuration = Number(process.env.CASTLE_NAV_DURATION || 1655);
const _navDomInteractive = Number(process.env.CASTLE_NAV_DOM_INTERACTIVE || 919.2);
const _navDcl = Number(process.env.CASTLE_NAV_DCL || 1057.5);
const _navUnload = Number(process.env.CASTLE_NAV_UNLOAD || 655.4);
const _navResponseEnd = Number(process.env.CASTLE_NAV_RESPONSE_END || 760.1);
_defineNativeProto(_PerfNavCtor, 'PerformanceNavigationTiming', {
  unloadEventStart: { get() { return _navUnload; } }, unloadEventEnd: { get() { return _navUnload; } },
  domInteractive: { get() { return _navDomInteractive; } },
  domContentLoadedEventStart: { get() { return _navDcl; } }, domContentLoadedEventEnd: { get() { return _navDcl; } },
  domComplete: { get() { return _navDuration - 1.1; } },
  loadEventStart: { get() { return _navDuration; } }, loadEventEnd: { get() { return _navDuration; } },
  type: { get() { return 'reload'; } }, redirectCount: { get() { return 0; } },
  initiatorType: { get() { return 'navigation'; } }, nextHopProtocol: { get() { return 'h2'; } },
  deliveryType: { get() { return ''; } }, workerStart: { get() { return 0; } },
  redirectStart: { get() { return 0; } }, redirectEnd: { get() { return 0; } },
  fetchStart: { get() { return 1; } }, domainLookupStart: { get() { return 1; } }, domainLookupEnd: { get() { return 1; } },
  connectStart: { get() { return 3.2; } }, connectEnd: { get() { return 250.9; } },
  secureConnectionStart: { get() { return 5.2; } }, requestStart: { get() { return 251; } },
  responseStart: { get() { return 506.1; } }, responseEnd: { get() { return _navResponseEnd; } },
  transferSize: { get() { return 76213; } }, encodedBodySize: { get() { return 75913; } }, decodedBodySize: { get() { return 300866; } },
  serverTiming: { get() { return []; } }, renderBlockingStatus: { get() { return 'non-blocking'; } },
  responseStatus: { get() { return 200; } }, contentType: { get() { return 'text/html'; } }, contentEncoding: { get() { return 'gzip'; } },
  finalResponseHeadersStart: { get() { return 506.1; } }, firstInterimResponseStart: { get() { return 0; } },
  workerRouterEvaluationStart: { get() { return 0; } }, workerCacheLookupStart: { get() { return 0; } },
  workerMatchedSourceType: { get() { return ''; } }, workerFinalSourceType: { get() { return ''; } },
  confidence: { get() { return {}; } }, criticalCHRestart: { get() { return 0; } },
  activationStart: { get() { return 0; } }, toJSON() { return {}; }, notRestoredReasons: { get() { return null; } },
});
const _PerfMarkCtor = _nativeCtor('PerformanceMark');
_PerfMarkCtor.prototype = Object.create(_PerfEntryCtor.prototype);
_defineNativeProto(_PerfMarkCtor, 'PerformanceMark', { detail: { get() { return null; } } });
const _PerfNavigationCtor = _nativeCtor('PerformanceNavigation');
_defineNativeProto(_PerfNavigationCtor, 'PerformanceNavigation', {
  type: { get() { return 1; } }, redirectCount: { get() { return 0; } },
  toJSON() { return {}; },
});
function _makePerfEntry(C, name, type, start, duration) {
  const x = Object.create(C.prototype);
  x._name = String(name); x._entryType = String(type); x._startTime = Number(start) || 0; x._duration = Number(duration) || 0;
  try { env.setObjNative(x, C.name); } catch (e) {}
  return x;
}
function _makeFakePerformance() {
  const nav = _makePerfEntry(_PerfNavCtor, fakeLocation.href, 'navigation', 0, _navDuration);
  const legacyNavigation = Object.create(_PerfNavigationCtor.prototype);
  try { env.setObjNative(legacyNavigation, 'PerformanceNavigation'); } catch (e) {}
  const markStart = Number(process.env.CASTLE_MARK_START || 918);
  const marks = _PERF_MARKS.map((name) => _makePerfEntry(_PerfMarkCtor, name, 'mark', markStart, 0));
  const total = Number(process.env.CASTLE_MEMORY_TOTAL || 98006835);
  const used = Number(process.env.CASTLE_MEMORY_USED || 91463363);
  const MemCtor = _nativeCtor('Object');
  MemCtor.prototype = Object.create(Object.prototype);
  _defineNativeProto(MemCtor, 'Object', {
    totalJSHeapSize: { get() { return total; } }, usedJSHeapSize: { get() { return used; } },
    jsHeapSizeLimit: { get() { return 4395630592; } },
  });
  const memory = Object.create(MemCtor.prototype);
  try { env.setObjNative(memory, 'MemoryInfo'); } catch (e) {}
  const PCtor = _nativeCtor('Performance');
  _defineNativeProto(PCtor, 'Performance', {
    timeOrigin: { get() { return Date.now(); } },
    memory: { get() { return memory; } },
    getEntriesByType(type) {
      type = String(type);
      if (type === 'navigation') return [nav];
      if (type === 'mark') return marks.slice();
      return [];
    },
    getEntriesByName(name, type) {
      return (type === undefined || String(type) === 'mark') ? marks.filter((x) => x.name === String(name)) : [];
    },
    getEntries() { return [nav].concat(marks); },
    mark() {}, measure() {}, clearMarks() {}, clearMeasures() {},
    clearResourceTimings() {}, setResourceTimingBufferSize() {},
    now() { return Number(_hrtimeBig() / 1000n) / 1000; },
    toJSON() { return {}; },
    navigation: { get() { return legacyNavigation; } }, timing: { get() { return {}; } },
    eventCounts: { get() { return {}; } }, interactionCount: { get() { return 0; } },
  });
  const p = Object.create(PCtor.prototype);
  try { env.setObjNative(p, 'Performance'); } catch (e) {}
  return p;
}

fakeNavigator.sendBeacon = (url, data) => { fakeFetch._log.push({ beacon: String(url) }); return true; };

// ---------- webpack chunk 捕获 ----------
const captured = {};
const chunkArr = [];
chunkArr.push = function (chunk) {
  const mods = chunk[1] || {};
  for (const id in mods) captured[id] = mods[id];
  return chunkArr.length;
};

// ---------- 组装 window ----------
const fakeWindow = {
  navigator: fakeNavigator,
  document: fakeDocument,
  location: fakeLocation,
  crypto: fakeCrypto,
  // screen / 视口：2026-08-16 真实浏览器实抓（早期写死 1280x720，与真机不符）
  screen: {
    width: 2560, height: 1440, availWidth: 2560, availHeight: 1392,
    colorDepth: 24, pixelDepth: 24, availLeft: 0, availTop: 0,
    orientation: { type: 'landscape-primary', angle: 0, addEventListener() {}, removeEventListener() {} },
  },
  // Chrome 的当前远程调试窗口实际是无边框/窄窗：outer 尺寸不是 inner+边框。
  // Castle 会直接采集这些值，使用旧的 1313x985 会让整段信号进入不同分支。
  innerWidth: 1297, innerHeight: 800, outerWidth: 160, outerHeight: 28,
  screenX: -32000, screenY: -32000, screenLeft: -32000, screenTop: -32000,
  devicePixelRatio: 1,
  performance: _makeFakePerformance(),
  styleMedia: (() => {
    const C = _nativeCtor('StyleMedia');
    _defineNativeProto(C, 'StyleMedia', {
      type: { get() { return 'screen'; } },
      matchMedium() { return false; },
    });
    const x = Object.create(C.prototype);
    try { env.setObjNative(x, 'StyleMedia'); } catch (e) {}
    return x;
  })(),
  atob: (s) => _Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => {
    const text = String(s);
    fakeWindow.__btoa = fakeWindow.__btoa || [];
    fakeWindow.__btoa.push(text.length);
    if (typeof _process !== 'undefined' && _process.env.CASTLE_BTOA_STACK) {
      fakeWindow.__btoaStacks = fakeWindow.__btoaStacks || [];
      if (fakeWindow.__btoaStacks.length < 32) {
        fakeWindow.__btoaStacks.push({
          len: text.length,
          stack: String(new Error().stack || '').split('\n').slice(1, 7),
        });
      }
    }
    if (_process.env.CASTLE_BTOA_BYTES_FILE && text.length >= 1000) {
      try {
        const p = _process.env.CASTLE_BTOA_BYTES_FILE;
        const prior = _fs.existsSync(p) ? JSON.parse(_fs.readFileSync(p, 'utf8')) : [];
        if (prior.length < 4) { prior.push(Array.from(text, (c) => c.charCodeAt(0))); _fs.writeFileSync(p, JSON.stringify(prior)); }
      } catch (e) {}
    }
    return _Buffer.from(text, 'binary').toString('base64');
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
  addEventListener(type, fn) { _addEvent(_eventBuckets.window, type, fn); },
  removeEventListener(type, fn) { _removeEvent(_eventBuckets.window, type, fn); },
  dispatchEvent(ev) { if (ev && ev.type) _dispatchEvent(_eventBuckets.window, ev.type, ev); return true; },
  requestIdleCallback: (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0),
  cancelIdleCallback: (id) => clearTimeout(id),
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
  scheduler: {
    postTask: (cb, opts) => _RealPromise.resolve().then(() => cb()),
    yield: () => _RealPromise.resolve(),
  },
  webpackChunk_twitter_responsive_web: chunkArr,
  TextEncoder, TextDecoder, URL, URLSearchParams,
  fetch: fakeFetch,
  XMLHttpRequest: FakeXHR,
  WebSocket: FakeWebSocket,
  Worker: FakeWorker,
  SharedWorker: FakeSharedWorker,
  Blob: FakeBlob,
  OffscreenCanvas: FakeOffscreenCanvas,
  OfflineAudioContext: FakeOfflineAudioContext,
  webkitOfflineAudioContext: FakeOfflineAudioContext,
  AudioContext: FakeAudioContext,
  webkitAudioContext: FakeAudioContext,
  RTCPeerConnection: FakeRTCPeerConnection,
  webkitRTCPeerConnection: FakeRTCPeerConnection,
  matchMedia: fakeMatchMedia,
  speechSynthesis: fakeSpeechSynthesis,
};
// 后续 createElement('iframe') 直接拿到与顶层环境一致的对象。
_fakeWindowRef = fakeWindow;
_fakeDocumentRef = fakeDocument;
// ---------- 真 Chrome 才有的 window 全局（2026-08-17 由 _win.js 探针实测补齐）----------
// Castle 会读一批全局做环境校验：一半是「真 Chrome 必有」（缺了就暴露非浏览器），
// 另一半是「自动化/其他内核专属」（有了才暴露，必须保持 undefined）。
// 这里只补前者，值按 Chrome 151 实抓；safari / opr / InstallTrigger / __nightmare /
// domAutomation / ethereum 等一律不定义。
fakeWindow.chrome = {
  loadTimes: env.setFuncNative(function loadTimes() {
    const t = Date.now() / 1000;
    return {
      requestTime: t - 3.2, startLoadTime: t - 3.2, commitLoadTime: t - 2.9,
      finishDocumentLoadTime: t - 1.8, finishLoadTime: t - 1.2, firstPaintTime: t - 2.1,
      firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true,
      wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false,
      connectionInfo: 'h2',
    };
  }, 'loadTimes', 0),
  csi: env.setFuncNative(function csi() {
    return { startE: Date.now() - 3200, onloadT: Date.now() - 1200, pageT: 3184.2, tran: 15 };
  }, 'csi', 0),
  app: {
    isInstalled: false,
    getDetails: env.setFuncNative(function getDetails() { return null; }, 'getDetails', 0),
    getIsInstalled: env.setFuncNative(function getIsInstalled() { return false; }, 'getIsInstalled', 0),
    installState: env.setFuncNative(function installState(cb) { setTimeout(() => cb('not_installed'), 0); }, 'installState', 0),
    runningState: env.setFuncNative(function runningState() { return 'cannot_run'; }, 'runningState', 0),
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
  },
};
// CSS：属性名与顺序照抄真实 Chrome 的 Object.getOwnPropertyNames(CSS)
fakeWindow.CSS = (() => {
  const css = {};
  css.highlights = new Map();
  for (const unit of ['Hz', 'Q', 'cap', 'ch', 'cm', 'cqb', 'cqh', 'cqi', 'cqmax', 'cqmin', 'cqw',
    'deg', 'dpcm', 'dpi', 'dppx', 'dvb', 'dvh', 'dvi', 'dvmax', 'dvmin', 'dvw', 'em']) {
    css[unit] = env.setFuncNative(((u) => function (v) { return { value: v, unit: u }; })(unit), unit, 1);
  }
  css.escape = env.setFuncNative(function escape(s) { return String(s).replace(/[^\w-]/g, (c) => '\\' + c); }, 'escape', 1);
  for (const unit of ['ex', 'fr', 'grad', 'ic', 'in', 'kHz', 'lh', 'lvb', 'lvh', 'lvi', 'lvmax',
    'lvmin', 'lvw', 'mm', 'ms', 'number', 'pc', 'percent', 'pt', 'px', 'rad', 'rcap', 'rch']) {
    css[unit] = env.setFuncNative(((u) => function (v) { return { value: v, unit: u }; })(unit), unit, 1);
  }
  css.registerProperty = env.setFuncNative(function registerProperty() {}, 'registerProperty', 1);
  for (const unit of ['rem', 'rex', 'ric', 'rlh', 's']) {
    css[unit] = env.setFuncNative(((u) => function (v) { return { value: v, unit: u }; })(unit), unit, 1);
  }
  css.supports = env.setFuncNative(function supports() { return true; }, 'supports', 1);
  for (const unit of ['svb', 'svh', 'svi', 'svmax', 'svmin', 'svw', 'turn', 'vb', 'vh', 'vi',
    'vmax', 'vmin', 'vw', 'x']) {
    css[unit] = env.setFuncNative(((u) => function (v) { return { value: v, unit: u }; })(unit), unit, 1);
  }
  css.paintWorklet = { addModule: () => Promise.resolve() };
  return env.setObjNative(css, 'CSS');
})();
// getComputedStyle：真实 Chrome 上一个裸 div 的计算样式（实抓的常用子集；
// CASTLE_DEBUG=1 会把 SDK 实际读取但这里缺的属性名打出来，按需补）。
const _COMPUTED = {
  'display': 'block', 'position': 'static', 'visibility': 'visible', 'opacity': '1',
  'width': '1234px', 'height': '0px', 'inline-size': '1234px', 'block-size': '0px',
  'font-family': '"Noto Sans SC"', 'font-size': '15px', 'font-weight': '400',
  'font-style': 'normal', 'font-stretch': '100%', 'line-height': 'normal',
  'letter-spacing': 'normal', 'word-spacing': '0px', 'text-align': 'start',
  'text-transform': 'none', 'text-rendering': 'auto', 'direction': 'ltr',
  'writing-mode': 'horizontal-tb', 'color': 'rgb(15, 20, 25)',
  'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none',
  'border-top-width': '0px', 'border-top-style': 'none', 'border-top-color': 'rgb(15, 20, 25)',
  'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '0px', 'margin-left': '0px',
  'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
  'top': 'auto', 'left': 'auto', 'right': 'auto', 'bottom': 'auto', 'z-index': 'auto',
  'overflow-x': 'visible', 'overflow-y': 'visible', 'box-sizing': 'content-box',
  'transform': 'none', 'transition-duration': '0s', 'animation-name': 'none',
  'zoom': '1', 'cursor': 'auto', 'pointer-events': 'auto', 'user-select': 'auto',
  'color-scheme': 'light', 'touch-action': 'auto', 'appearance': 'none',
  '-webkit-font-smoothing': 'auto', '-webkit-locale': '"zh"',
  'text-size-adjust': '100%', 'tab-size': '8', 'white-space-collapse': 'collapse',
  "--tw-contrast": "",
  "--color-blue-100": "192 100% 87%",
  "--tw-backdrop-sepia": "",
  "--color-gray-400": "203 23% 69%",
  "--color-drop-shadow": "101 119 134",
  "--tw-sepia": "",
  "--tw-skew-x": "0",
  "--color-text": "210 25% 8%",
  "--tw-backdrop-saturate": "",
  "--tw-backdrop-blur": "",
  "--color-gray-100": "197 16% 91%",
  "--color-background": "0 0% 100%",
  "--color-red-500": "0 84% 60%",
  "--tw-translate-x": "0",
  "--color-blue-200": "196 100% 80%",
  "--color-gray-200": "201 23% 85%",
  "--tw-backdrop-invert": "",
  "--tw-saturate": "",
  "--tw-grayscale": "",
  "--tw-scale-x": "1",
  "--tw-backdrop-hue-rotate": "",
  "--tw-gradient-to-position": "",
  "--tw-brightness": "",
  "--jbgo": "1",
  "--tw-backdrop-grayscale": "",
  "--color-gray-300": "201 23% 78%",
  "--tw-hue-rotate": "",
  "--tw-scale-y": "1",
  "--tw-backdrop-contrast": "",
  "--tw-drop-shadow": "",
  "--tw-skew-y": "0",
  "--tw-backdrop-brightness": "",
  "--color-gray-500": "205 20% 59%",
  "--tw-blur": "",
  "--bg-gradient-from": "transparent",
  "--bg-gradient-to": "transparent",
  "--jbo": "1",
  "--tw-translate-y": "0",
  "--tw-backdrop-opacity": "",
  "--tw-invert": "",
  "--color-green-500": "142 76% 36%",
  "--color-blue-500": "204 88% 53%",
  "--tw-gradient-from-position": "",
  "--jtxo": "1",
  "--tw-rotate": "0",
};
const _COMPUTED_KEYS = ["accent-color","align-content","align-items","align-self","alignment-baseline","anchor-name","anchor-scope","animation-composition","animation-delay","animation-direction","animation-duration","animation-fill-mode","animation-iteration-count","animation-name","animation-play-state","animation-range-end","animation-range-start","animation-timeline","animation-timing-function","animation-trigger","app-region","appearance","aspect-ratio","backdrop-filter","backface-visibility","background-attachment","background-blend-mode","background-clip","background-color","background-image","background-origin","background-position","background-repeat","background-size","baseline-shift","baseline-source","block-size","border-block-end-color","border-block-end-style","border-block-end-width","border-block-start-color","border-block-start-style","border-block-start-width","border-bottom-color","border-bottom-left-radius","border-bottom-right-radius","border-bottom-style","border-bottom-width","border-collapse","border-end-end-radius","border-end-start-radius","border-image-outset","border-image-repeat","border-image-slice","border-image-source","border-image-width","border-inline-end-color","border-inline-end-style","border-inline-end-width","border-inline-start-color","border-inline-start-style","border-inline-start-width","border-left-color","border-left-style","border-left-width","border-right-color","border-right-style","border-right-width","border-shape","border-start-end-radius","border-start-start-radius","border-top-color","border-top-left-radius","border-top-right-radius","border-top-style","border-top-width","bottom","box-decoration-break","box-shadow","box-sizing","break-after","break-before","break-inside","buffered-rendering","caption-side","caret-animation","caret-color","caret-shape","clear","clip","clip-path","clip-rule","color","color-interpolation","color-interpolation-filters","color-rendering","color-scheme","column-count","column-fill","column-gap","column-height","column-rule-break","column-rule-color","column-rule-inset-cap-end","column-rule-inset-cap-start","column-rule-inset-junction-end","column-rule-inset-junction-start","column-rule-style","column-rule-visibility-items","column-rule-width","column-span","column-width","column-wrap","contain","contain-intrinsic-block-size","contain-intrinsic-height","contain-intrinsic-inline-size","contain-intrinsic-size","contain-intrinsic-width","container-name","container-type","content","content-visibility","corner-bottom-left-shape","corner-bottom-right-shape","corner-end-end-shape","corner-end-start-shape","corner-start-end-shape","corner-start-start-shape","corner-top-left-shape","corner-top-right-shape","counter-increment","counter-reset","counter-set","cursor","cx","cy","d","direction","display","dominant-baseline","dynamic-range-limit","empty-cells","field-sizing","fill","fill-opacity","fill-rule","filter","flex-basis","flex-direction","flex-grow","flex-line-count","flex-shrink","flex-wrap","float","flood-color","flood-opacity","font-family","font-feature-settings","font-kerning","font-language-override","font-optical-sizing","font-palette","font-size","font-size-adjust","font-stretch","font-style","font-synthesis-small-caps","font-synthesis-style","font-synthesis-weight","font-variant","font-variant-alternates","font-variant-caps","font-variant-east-asian","font-variant-emoji","font-variant-ligatures","font-variant-numeric","font-variant-position","font-variation-settings","font-weight","forced-color-adjust","grid-auto-columns","grid-auto-flow","grid-auto-rows","grid-column-end","grid-column-start","grid-row-end","grid-row-start","grid-template-areas","grid-template-columns","grid-template-rows","height","hyphenate-character","hyphenate-limit-chars","hyphens","image-orientation","image-rendering","initial-letter","inline-size","inset-block-end","inset-block-start","inset-inline-end","inset-inline-start","interactivity","interest-delay-end","interest-delay-start","interpolate-size","isolation","justify-content","justify-items","justify-self","left","letter-spacing","lighting-color","line-break","line-height","list-style-image","list-style-position","list-style-type","margin-block-end","margin-block-start","margin-bottom","margin-inline-end","margin-inline-start","margin-left","margin-right","margin-top","marker-end","marker-mid","marker-start","mask-clip","mask-composite","mask-image","mask-mode","mask-origin","mask-position","mask-repeat","mask-size","mask-type","math-depth","math-shift","math-style","max-block-size","max-height","max-inline-size","max-width","min-block-size","min-height","min-inline-size","min-width","mix-blend-mode","object-fit","object-position","object-view-box","offset-anchor","offset-distance","offset-path","offset-position","offset-rotate","opacity","order","orphans","outline-color","outline-offset","outline-style","outline-width","overflow-anchor","overflow-block","overflow-clip-margin","overflow-inline","overflow-wrap","overflow-x","overflow-y","overlay","overscroll-behavior-block","overscroll-behavior-inline","overscroll-behavior-x","overscroll-behavior-y","padding-block-end","padding-block-start","padding-bottom","padding-inline-end","padding-inline-start","padding-left","padding-right","padding-top","paint-order","perspective","perspective-origin","pointer-events","position","position-anchor","position-area","position-try-fallbacks","position-try-order","position-visibility","print-color-adjust","quotes","r","reading-flow","reading-order","resize","right","rotate","row-gap","row-rule-break","row-rule-color","row-rule-inset-cap-end","row-rule-inset-cap-start","row-rule-inset-junction-end","row-rule-inset-junction-start","row-rule-style","row-rule-visibility-items","row-rule-width","ruby-align","ruby-overhang","ruby-position","rule-overlap","rx","ry","scale","scroll-axis-lock","scroll-behavior","scroll-initial-target","scroll-margin-block-end","scroll-margin-block-start","scroll-margin-bottom","scroll-margin-inline-end","scroll-margin-inline-start","scroll-margin-left","scroll-margin-right","scroll-margin-top","scroll-marker-group","scroll-padding-block-end","scroll-padding-block-start","scroll-padding-bottom","scroll-padding-inline-end","scroll-padding-inline-start","scroll-padding-left","scroll-padding-right","scroll-padding-top","scroll-snap-align","scroll-snap-stop","scroll-snap-type","scroll-target-group","scroll-timeline-axis","scroll-timeline-name","scrollbar-color","scrollbar-gutter","scrollbar-width","shape-image-threshold","shape-margin","shape-outside","shape-rendering","speak","stop-color","stop-opacity","stroke","stroke-dasharray","stroke-dashoffset","stroke-linecap","stroke-linejoin","stroke-miterlimit","stroke-opacity","stroke-width","tab-size","table-layout","text-align","text-align-last","text-anchor","text-autospace","text-box-edge","text-box-trim","text-combine-upright","text-decoration","text-decoration-color","text-decoration-line","text-decoration-skip-ink","text-decoration-style","text-decoration-thickness","text-emphasis-color","text-emphasis-position","text-emphasis-style","text-fit","text-indent","text-justify","text-orientation","text-overflow","text-rendering","text-shadow","text-size-adjust","text-spacing-trim","text-transform","text-underline-offset","text-underline-position","text-wrap-mode","text-wrap-style","timeline-scope","timeline-trigger-activation-range-end","timeline-trigger-activation-range-start","timeline-trigger-active-range-end","timeline-trigger-active-range-start","timeline-trigger-name","timeline-trigger-source","top","touch-action","transform","transform-box","transform-origin","transform-style","transition-behavior","transition-delay","transition-duration","transition-property","transition-timing-function","translate","trigger-scope","unicode-bidi","user-select","vector-effect","vertical-align","view-timeline-axis","view-timeline-inset","view-timeline-name","view-transition-class","view-transition-group","view-transition-name","view-transition-scope","visibility","white-space-collapse","widows","width","will-change","window-drag","word-break","word-spacing","writing-mode","x","y","z-index","zoom","-webkit-border-horizontal-spacing","-webkit-border-image","-webkit-border-vertical-spacing","-webkit-box-align","-webkit-box-decoration-break","-webkit-box-direction","-webkit-box-flex","-webkit-box-ordinal-group","-webkit-box-orient","-webkit-box-pack","-webkit-box-reflect","-webkit-font-smoothing","-webkit-line-break","-webkit-line-clamp","-webkit-locale","-webkit-mask-box-image","-webkit-mask-box-image-outset","-webkit-mask-box-image-repeat","-webkit-mask-box-image-slice","-webkit-mask-box-image-source","-webkit-mask-box-image-width","-webkit-mask-position-x","-webkit-mask-position-y","-webkit-rtl-ordering","-webkit-ruby-position","-webkit-tap-highlight-color","-webkit-text-combine","-webkit-text-decorations-in-effect","-webkit-text-fill-color","-webkit-text-orientation","-webkit-text-security","-webkit-text-stroke-color","-webkit-text-stroke-width","-webkit-user-drag","-webkit-user-modify","-webkit-writing-mode","--bg-gradient-to","--jbo","--jtxo","--bg-gradient-from","--jbgo"];
const _COMPUTED_KEYS_BODY = (() => {
  const k = _COMPUTED_KEYS.slice();
  const at = k.indexOf('--jtxo');
  if (at >= 0) k.splice(at, 0, '--device-height', '--device-width');
  return k;
})();
// 实抓的登录提交序列中，前 477 个 CSS 属性名稳定，尾部由元素类型和
// 页面动态样式决定；保留尾部实值并允许采集器通过环境变量覆盖整组序列。
const _COMPUTED_KEY_VARIANT_TAILS = [["--tw-contrast","--color-blue-100","--tw-backdrop-sepia","--color-gray-400","--color-drop-shadow","--tw-sepia","--tw-skew-x","--color-text","--tw-backdrop-saturate","--tw-backdrop-blur","--color-gray-100","--color-background","--color-red-500","--tw-translate-x","--color-blue-200","--color-gray-200","--tw-backdrop-invert","--tw-saturate","--tw-grayscale","--tw-scale-x","--tw-backdrop-hue-rotate","--tw-gradient-to-position","--tw-brightness","--jbgo","--tw-backdrop-grayscale","--color-gray-300","--tw-hue-rotate","--tw-scale-y","--tw-backdrop-contrast","--tw-drop-shadow","--tw-skew-y","--tw-backdrop-brightness","--color-gray-500","--tw-blur","--bg-gradient-from","--bg-gradient-to","--jbo","--tw-translate-y","--tw-backdrop-opacity","--tw-invert","--color-green-500","--color-blue-500","--tw-gradient-from-position","--jtxo","--tw-rotate"],["--bg-gradient-to","--device-width","--jbo","--device-height","--jtxo","--bg-gradient-from","--jbgo"],["--bg-gradient-to","--jbo","--bg-gradient-from","--jtxo","--jbgo"],["--tw-contrast","--color-blue-100","--tw-backdrop-sepia","--color-gray-400","--jf-bg-color","--color-drop-shadow","--tw-sepia","--tw-skew-x","--color-text","--tw-backdrop-saturate","--tw-backdrop-blur","--color-gray-100","--color-background","--color-red-500","--tw-translate-x","--color-blue-200","--color-gray-200","--tw-backdrop-invert","--tw-saturate","--tw-grayscale","--tw-scale-x","--tw-backdrop-hue-rotate","--tw-gradient-to-position","--tw-brightness","--jbgo","--tw-backdrop-grayscale","--color-gray-300","--tw-hue-rotate","--tw-scale-y","--tw-backdrop-contrast","--tw-drop-shadow","--tw-skew-y","--tw-backdrop-brightness","--color-gray-500","--tw-blur","--bg-gradient-from","--bg-gradient-to","--jbo","--tw-translate-y","--tw-backdrop-opacity","--tw-invert","--color-green-500","--color-blue-500","--tw-gradient-from-position","--jtxo","--tw-rotate"],["--tw-contrast","--color-blue-100","--tw-backdrop-sepia","--color-gray-400","--jf-bg-color","--color-drop-shadow","--tw-sepia","--tw-skew-x","--color-text","--tw-backdrop-saturate","--tw-backdrop-blur","--color-gray-100","--color-background","--color-red-500","--tw-translate-x","--color-blue-200","--color-gray-200","--tw-backdrop-invert","--tw-saturate","--tw-grayscale","--jf-text-color","--tw-scale-x","--tw-backdrop-hue-rotate","--tw-gradient-to-position","--tw-brightness","--jbgo","--tw-backdrop-grayscale","--color-gray-300","--tw-hue-rotate","--tw-scale-y","--jf-text-size","--jf-border-color","--tw-backdrop-contrast","--tw-drop-shadow","--tw-skew-y","--tw-backdrop-brightness","--color-gray-500","--tw-blur","--bg-gradient-from","--bg-gradient-to","--jbo","--tw-translate-y","--tw-backdrop-opacity","--tw-invert","--color-green-500","--color-blue-500","--tw-gradient-from-position","--jtxo","--tw-rotate"],["--tw-contrast","--color-blue-100","--tw-backdrop-sepia","--color-gray-400","--jf-bg-color","--color-drop-shadow","--tw-sepia","--tw-skew-x","--color-text","--tw-backdrop-saturate","--tw-backdrop-blur","--color-gray-100","--color-background","--color-red-500","--tw-translate-x","--color-blue-200","--color-gray-200","--tw-backdrop-invert","--tw-saturate","--tw-grayscale","--jf-text-color","--tw-scale-x","--tw-backdrop-hue-rotate","--tw-gradient-to-position","--tw-brightness","--jbgo","--tw-backdrop-grayscale","--color-gray-300","--tw-hue-rotate","--tw-scale-y","--jf-text-size","--jf-border-color","--tw-backdrop-contrast","--tw-drop-shadow","--tw-skew-y","--tw-backdrop-brightness","--color-gray-500","--tw-blur","--bg-gradient-from","--bg-gradient-to","--jbo","--tw-translate-y","--tw-backdrop-opacity","--tw-invert","--color-green-500","--color-blue-500","--tw-gradient-from-position","--jtxo","--tw-rotate"],["--tw-contrast","--color-blue-100","--tw-backdrop-sepia","--color-gray-400","--color-drop-shadow","--tw-sepia","--tw-skew-x","--color-text","--tw-backdrop-saturate","--tw-backdrop-blur","--color-gray-100","--color-background","--color-red-500","--tw-translate-x","--color-blue-200","--color-gray-200","--tw-backdrop-invert","--tw-saturate","--tw-grayscale","--tw-scale-x","--tw-backdrop-hue-rotate","--tw-gradient-to-position","--tw-brightness","--jbgo","--tw-backdrop-grayscale","--color-gray-300","--tw-hue-rotate","--tw-scale-y","--tw-backdrop-contrast","--tw-drop-shadow","--tw-skew-y","--tw-backdrop-brightness","--color-gray-500","--tw-blur","--bg-gradient-from","--bg-gradient-to","--jbo","--tw-translate-y","--tw-backdrop-opacity","--tw-invert","--color-green-500","--color-blue-500","--tw-gradient-from-position","--jtxo","--tw-rotate"],["--tw-contrast","--color-blue-100","--tw-backdrop-sepia","--color-gray-400","--jf-line-height","--color-drop-shadow","--tw-sepia","--tw-skew-x","--color-text","--tw-backdrop-saturate","--tw-backdrop-blur","--color-gray-100","--color-background","--color-red-500","--tw-translate-x","--color-blue-200","--color-gray-200","--tw-backdrop-invert","--tw-saturate","--tw-grayscale","--jf-text-color","--tw-scale-x","--tw-backdrop-hue-rotate","--tw-gradient-to-position","--tw-brightness","--jbgo","--tw-backdrop-grayscale","--color-gray-300","--tw-hue-rotate","--tw-scale-y","--jf-text-size","--tw-backdrop-contrast","--tw-drop-shadow","--tw-skew-y","--tw-backdrop-brightness","--color-gray-500","--tw-blur","--bg-gradient-from","--bg-gradient-to","--jbo","--tw-translate-y","--tw-backdrop-opacity","--tw-invert","--color-green-500","--color-blue-500","--tw-gradient-from-position","--jtxo","--tw-rotate"],["--tw-contrast","--color-blue-100","--tw-backdrop-sepia","--color-gray-400","--jf-line-height","--color-drop-shadow","--tw-sepia","--tw-skew-x","--color-text","--tw-backdrop-saturate","--tw-backdrop-blur","--color-gray-100","--color-background","--color-red-500","--tw-translate-x","--color-blue-200","--color-gray-200","--tw-backdrop-invert","--tw-saturate","--tw-grayscale","--jf-text-color","--tw-scale-x","--tw-backdrop-hue-rotate","--tw-gradient-to-position","--tw-brightness","--jbgo","--tw-backdrop-grayscale","--color-gray-300","--tw-hue-rotate","--tw-scale-y","--jf-text-size","--tw-backdrop-contrast","--tw-drop-shadow","--tw-skew-y","--tw-backdrop-brightness","--color-gray-500","--tw-blur","--bg-gradient-from","--bg-gradient-to","--jbo","--tw-translate-y","--tw-backdrop-opacity","--tw-invert","--color-green-500","--color-blue-500","--tw-gradient-from-position","--jtxo","--tw-rotate"],["--tw-contrast","--color-blue-100","--tw-backdrop-sepia","--color-gray-400","--jf-line-height","--color-drop-shadow","--tw-sepia","--tw-skew-x","--color-text","--tw-backdrop-saturate","--tw-backdrop-blur","--color-gray-100","--color-background","--color-red-500","--tw-translate-x","--color-blue-200","--color-gray-200","--tw-backdrop-invert","--tw-saturate","--tw-grayscale","--jf-text-color","--tw-scale-x","--tw-backdrop-hue-rotate","--tw-gradient-to-position","--tw-brightness","--jbgo","--tw-backdrop-grayscale","--color-gray-300","--tw-hue-rotate","--tw-scale-y","--jf-text-size","--tw-backdrop-contrast","--tw-drop-shadow","--tw-skew-y","--tw-backdrop-brightness","--color-gray-500","--tw-blur","--bg-gradient-from","--bg-gradient-to","--jbo","--tw-translate-y","--tw-backdrop-opacity","--tw-invert","--color-green-500","--color-blue-500","--tw-gradient-from-position","--jtxo","--tw-rotate"],["--tw-contrast","--color-blue-100","--tw-backdrop-sepia","--color-gray-400","--jf-line-height","--color-drop-shadow","--tw-sepia","--tw-skew-x","--color-text","--tw-backdrop-saturate","--tw-backdrop-blur","--color-gray-100","--color-background","--color-red-500","--tw-translate-x","--color-blue-200","--color-gray-200","--tw-backdrop-invert","--tw-saturate","--tw-grayscale","--jf-text-color","--tw-scale-x","--tw-backdrop-hue-rotate","--tw-gradient-to-position","--tw-brightness","--jbgo","--tw-backdrop-grayscale","--color-gray-300","--tw-hue-rotate","--tw-scale-y","--jf-text-size","--tw-backdrop-contrast","--tw-drop-shadow","--tw-skew-y","--tw-backdrop-brightness","--color-gray-500","--tw-blur","--bg-gradient-from","--bg-gradient-to","--jbo","--tw-translate-y","--tw-backdrop-opacity","--tw-invert","--color-green-500","--color-blue-500","--tw-gradient-from-position","--jtxo","--tw-rotate"],["--tw-contrast","--color-blue-100","--tw-backdrop-sepia","--color-gray-400","--jf-line-height","--color-drop-shadow","--tw-sepia","--tw-skew-x","--color-text","--tw-backdrop-saturate","--tw-backdrop-blur","--color-gray-100","--color-background","--color-red-500","--tw-translate-x","--color-blue-200","--color-gray-200","--tw-backdrop-invert","--tw-saturate","--tw-grayscale","--jf-text-color","--tw-scale-x","--tw-backdrop-hue-rotate","--tw-gradient-to-position","--tw-brightness","--jbgo","--tw-backdrop-grayscale","--color-gray-300","--tw-hue-rotate","--tw-scale-y","--jf-text-size","--tw-backdrop-contrast","--tw-drop-shadow","--tw-skew-y","--tw-backdrop-brightness","--color-gray-500","--tw-blur","--bg-gradient-from","--bg-gradient-to","--jbo","--tw-translate-y","--tw-backdrop-opacity","--tw-invert","--color-green-500","--color-blue-500","--tw-gradient-from-position","--jtxo","--tw-rotate"],["--tw-contrast","--color-blue-100","--tw-backdrop-sepia","--color-gray-400","--jf-line-height","--color-drop-shadow","--tw-sepia","--tw-skew-x","--color-text","--tw-backdrop-saturate","--tw-backdrop-blur","--color-gray-100","--color-background","--color-red-500","--tw-translate-x","--color-blue-200","--color-gray-200","--tw-backdrop-invert","--tw-saturate","--tw-grayscale","--jf-text-color","--tw-scale-x","--tw-backdrop-hue-rotate","--tw-gradient-to-position","--tw-brightness","--jbgo","--tw-backdrop-grayscale","--color-gray-300","--tw-hue-rotate","--tw-scale-y","--jf-text-size","--tw-backdrop-contrast","--tw-drop-shadow","--tw-skew-y","--tw-backdrop-brightness","--color-gray-500","--tw-blur","--bg-gradient-from","--bg-gradient-to","--jbo","--tw-translate-y","--tw-backdrop-opacity","--tw-invert","--color-green-500","--color-blue-500","--tw-gradient-from-position","--jtxo","--tw-rotate"]];
const _COMPUTED_KEY_VARIANTS_DEFAULT = _COMPUTED_KEY_VARIANT_TAILS.map((tail) => _COMPUTED_KEYS.slice(0, 477).concat(tail));
const _COMPUTED_KEY_VARIANTS = (() => {
  const file = process.env.CASTLE_COMPUTED_KEYS_FILE;
  if (file) {
    try {
      const v = JSON.parse(_fs.readFileSync(file, 'utf8'));
      if (Array.isArray(v)) return v.map((x) => Array.isArray(x && x.keys) ? x.keys : x);
    } catch (e) {}
  }
  const raw = process.env.CASTLE_COMPUTED_KEYS_JSON_B64;
  if (!raw) return _COMPUTED_KEY_VARIANTS_DEFAULT;
  try {
    const v = JSON.parse(_Buffer.from(raw, 'base64').toString('utf8'));
    return Array.isArray(v) ? v : _COMPUTED_KEY_VARIANTS_DEFAULT;
  } catch (e) { return _COMPUTED_KEY_VARIANTS_DEFAULT; }
})();
let _computedCallIndex = 0;
const _computedVariantLimit = Number(process.env.CASTLE_COMPUTED_VARIANT_LIMIT || 1000);
const _computedMiss = new Set();
fakeWindow.getComputedStyle = env.setFuncNative(function getComputedStyle(el) {
  if (_process.env.CASTLE_COMPUTED_DEBUG) console.log('GCS_CALL', el && el.tagName);
  if (_process.env.CASTLE_DISABLE_COMPUTED === '1') return null;
  const callIndex = _computedCallIndex++;
  const variant = callIndex < _computedVariantLimit ? _COMPUTED_KEY_VARIANTS[callIndex] : null;
  const keys = Array.isArray(variant)
    ? variant
    : (el && String(el.tagName || '').toUpperCase() === 'BODY' ? _COMPUTED_KEYS_BODY : _COMPUTED_KEYS);
  const decl = {
    getPropertyValue(p) {
      p = String(p);
      if (!(p in _COMPUTED)) _computedMiss.add(p);
      return _COMPUTED[p] || '';
    },
    getPropertyPriority() { return ''; },
    setProperty() {}, removeProperty() { return ''; },
    item(i) { return keys[i] || ''; },
    length: keys.length,
  };
  keys.forEach((k, i) => { decl[i] = k; decl[k] = _COMPUTED[k] || ''; });
  if (_process.env.CASTLE_COMPUTED_PROBE) console.log('COMPUTED_PROBE', decl.length, decl[0], decl[481]);
  return env.setObjNative(decl, 'CSSStyleDeclaration');
}, 'getComputedStyle', 1);
fakeWindow.visualViewport = env.setObjNative({
  width: 1297, height: 800, scale: 1,
  offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0,
  onresize: null, onscroll: null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
}, 'VisualViewport');
fakeWindow.Notification = (() => {
  const N = env.setFuncNative(function Notification() { throw new TypeError('Illegal constructor'); }, 'Notification', 2);
  N.permission = 'default';
  N.maxActions = 2;
  N.requestPermission = env.setFuncNative(function requestPermission() { return Promise.resolve('default'); }, 'requestPermission', 0);
  return N;
})();
// 只被「typeof / in」探到的构造函数：给个原型链外壳即可
for (const ctorName of ['HTMLMediaElement', 'HTMLCanvasElement', 'HTMLVideoElement', 'HTMLAudioElement',
  'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'GPUAdapter', 'GPUDevice',
  'GPUCanvasContext', 'SerialPort', 'NetworkInformation', 'PressureObserver',
  'PerformanceLongAnimationFrameTiming', 'VisualViewport', 'CSSStyleDeclaration']) {
  if (fakeWindow[ctorName] === undefined) fakeWindow[ctorName] = env.getNativeProto(ctorName)[0];
}
// Castle checks the media API on HTMLVideoElement.prototype, not only on the
// individual element returned by createElement().  Chrome exposes the method
// on the prototype; leaving it as an own-property-only shim flips that probe.
if (fakeWindow.HTMLMediaElement && fakeWindow.HTMLMediaElement.prototype) {
  fakeWindow.HTMLMediaElement.prototype.canPlayType = makeCanPlayType('video');
}
if (fakeWindow.HTMLVideoElement && fakeWindow.HTMLVideoElement.prototype) {
  fakeWindow.HTMLVideoElement.prototype.canPlayType = makeCanPlayType('video');
  fakeWindow.HTMLVideoElement.prototype.getVideoPlaybackQuality = function getVideoPlaybackQuality() {
    return { creationTime: 0, totalVideoFrames: 0, droppedVideoFrames: 0, corruptedVideoFrames: 0 };
  };
}
if (fakeWindow.HTMLAudioElement && fakeWindow.HTMLAudioElement.prototype) {
  fakeWindow.HTMLAudioElement.prototype.canPlayType = makeCanPlayType('audio');
}
if (process.env.CASTLE_PROTO_TRACE && fakeWindow.HTMLVideoElement && fakeWindow.HTMLVideoElement.prototype) {
  const _vp = fakeWindow.HTMLVideoElement.prototype;
  fakeWindow.HTMLVideoElement.prototype = new Proxy(_vp, {
    has(target, prop) {
      console.log('VID_HAS', String(prop));
      return prop in target;
    },
  });
}
// console / eval / external：真浏览器必有，缺了等于直说「我不是浏览器」。
// console 全部做成空实现——SDK 的输出绝不能混进 stdout（Python 侧只认那一行 token）。
fakeWindow.console = (() => {
  const c = {};
  for (const m of ['debug', 'error', 'info', 'log', 'warn', 'dir', 'dirxml', 'table', 'trace',
    'group', 'groupCollapsed', 'groupEnd', 'clear', 'count', 'countReset', 'assert',
    'profile', 'profileEnd', 'time', 'timeLog', 'timeEnd', 'timeStamp']) {
    c[m] = env.setFuncNative(function () {}, m, 0);
  }
  c.context = env.setFuncNative(function context() {}, 'context', 0);
  c.createTask = env.setFuncNative(function createTask() { return { run: (f) => f() }; }, 'createTask', 1);
  c.memory = { jsHeapSizeLimit: 4395630592, totalJSHeapSize: 41943040, usedJSHeapSize: 27262976 };
  return env.setObjNative(c, 'console');
})();
fakeWindow.eval = eval;
fakeWindow.external = (() => {
  const [Ctor] = env.getNativeProto('External');
  Ctor.prototype.AddSearchProvider = env.setFuncNative(function AddSearchProvider() {}, 'AddSearchProvider', 0);
  Ctor.prototype.IsSearchProviderInstalled = env.setFuncNative(function IsSearchProviderInstalled() {}, 'IsSearchProviderInstalled', 0);
  return env.setObjNative(Object.create(Ctor.prototype), 'External');
})();
fakeWindow.cancelAnimationFrame = env.setFuncNative(function cancelAnimationFrame(id) { clearTimeout(id); }, 'cancelAnimationFrame', 1);
// Window.prompt is included in Castle's own-property collector via its
// native string representation; keep the function shape without opening a
// dialog in the offline runtime.
fakeWindow.prompt = env.setFuncNative(function prompt() { return null; }, 'prompt', 1);
fakeWindow.close = env.setFuncNative(function close() {}, 'close', 0);
for (const obsName of ['MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'PerformanceObserver']) {
  const Obs = env.setFuncNative(function (cb) { this._cb = cb; }, obsName, 1);
  Obs.prototype.observe = env.setFuncNative(function observe() {}, 'observe', 1);
  Obs.prototype.disconnect = env.setFuncNative(function disconnect() {}, 'disconnect', 0);
  Obs.prototype.takeRecords = env.setFuncNative(function takeRecords() { return []; }, 'takeRecords', 0);
  if (obsName === 'PerformanceObserver') Obs.supportedEntryTypes = ['element', 'event', 'first-input', 'largest-contentful-paint', 'layout-shift', 'longtask', 'mark', 'measure', 'navigation', 'paint', 'resource', 'visibility-state'];
  if (obsName === 'IntersectionObserver' || obsName === 'ResizeObserver') Obs.prototype.unobserve = env.setFuncNative(function unobserve() {}, 'unobserve', 1);
  fakeWindow[obsName] = Obs;
}
fakeWindow.length = 0;              // 无子 frame
fakeWindow.frameElement = null;     // 非 iframe 内
fakeWindow.name = '';
fakeWindow.origin = 'https://x.com';
fakeWindow.isSecureContext = true;
fakeWindow.crossOriginIsolated = false;
fakeWindow.closed = false;
fakeWindow.status = '';
fakeWindow.menubar = { visible: true };
fakeWindow.history = { length: 7, scrollRestoration: 'auto', state: null, pushState() {}, replaceState() {}, go() {}, back() {}, forward() {} };
fakeWindow._sentryDebugIds = {};    // x.com 真页面上由 Sentry 注入，缺失即与浏览器不符

fakeWindow.window = fakeWindow;
fakeWindow.self = fakeWindow;
fakeWindow.top = fakeWindow;
fakeWindow.parent = fakeWindow;
fakeWindow.globalThis = fakeWindow;

// 把标准内建挂到 fakeWindow —— SDK 顶部把 window 缓存为 n，之后用 n.JSON / n.Math 等
for (const k of ['JSON', 'Math', 'Date', 'Object', 'Array', 'Function', 'String', 'Number',
  'Boolean', 'Symbol', 'BigInt', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'EvalError', 'URIError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape',
  'queueMicrotask', 'structuredClone',
  'CompressionStream', 'DecompressionStream', 'ReadableStream', 'WritableStream',
  'TransformStream', 'TextEncoderStream', 'TextDecoderStream',
  'Response', 'Request', 'Headers', 'FormData', 'AbortController', 'AbortSignal',
  'MessageChannel', 'MessagePort', 'Event', 'EventTarget', 'CustomEvent', 'DOMException']) {
  if (global[k] !== undefined) fakeWindow[k] = global[k];
}

// 存储 / 空闲 API 存根
function _readStorageEnv(name) {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const json = _Buffer.from(raw, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) { return {}; }
}
function makeStorage(initial) {
  const m = new Map(Object.entries(initial || {}).map(([k, v]) => [String(k), String(v)]));
  return {
    getItem(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(String(k)); },
    clear() { m.clear(); },
    key(i) { return Array.from(m.keys())[i] ?? null; },
    get length() { return m.size; },
  };
}
fakeWindow.localStorage = makeStorage(_readStorageEnv('CASTLE_LOCAL_STORAGE_B64'));
fakeWindow.sessionStorage = makeStorage(_readStorageEnv('CASTLE_SESSION_STORAGE_B64'));
fakeWindow.indexedDB = { open() { const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null }; setTimeout(() => { if (typeof req.onerror === 'function') req.onerror({ type: 'error' }); }, 0); return req; }, deleteDatabase() { return {}; } };

const _process = process; // init() 会隐藏 process
// 诊断开关：默认安静（生产），仅 CASTLE_DEBUG=1 才吐补环境诊断 / worker dump / env 报告。
// 平时每步登录都要现生成 token，安静才干净；逆向或补丁重推时开它看全量诊断。
const DEBUG = !!_process.env.CASTLE_DEBUG;
if (DEBUG && _process.env.CASTLE_ENV_COUNTS) {
  console.log('env own keys:', Object.getOwnPropertyNames(fakeWindow).length,
    Object.getOwnPropertyNames(fakeDocument).length,
    Object.getOwnPropertyNames(fakeDocument.documentElement || {}).length,
    Object.getOwnPropertyNames(fakeDocument.body || {}).length);
  console.log('env probes:', !!docProxy.body, !!docProxy.documentElement, typeof global.getComputedStyle, typeof fakeWindow.getComputedStyle);
}
_process.on('uncaughtException', (e) => { if (DEBUG) console.log('UNCAUGHT:', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e); });
_process.on('unhandledRejection', (e) => { if (DEBUG) console.log('UNHANDLED_REJECTION:', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e); });

// 诊断：包 navigator / document，暴露 undefined 访问
const navProxy = env.createProxy(fakeNavigator, 'navigator', 0);
const docProxy = env.createProxy(fakeDocument, 'document', 0);
fakeWindow.navigator = navProxy;
fakeWindow.document = docProxy;

env.init({ window: fakeWindow, document: docProxy, navigator: navProxy, location: fakeLocation });

// init 把 global.globalThis 指向 fakeWindow，chunk 用 globalThis.webpackChunk，故已就位。
// 冗余：global 上也放一份。
Object.defineProperty(global, 'webpackChunk_twitter_responsive_web', { value: chunkArr, writable: true, configurable: true });
Object.defineProperty(global, 'crypto', { value: fakeCrypto, writable: true, configurable: true });
Object.defineProperty(global, 'performance', { value: fakeWindow.performance, writable: true, configurable: true });
global.TextEncoder = TextEncoder; global.TextDecoder = TextDecoder;
global.atob = fakeWindow.atob; global.btoa = fakeWindow.btoa;
if (_process.env.CASTLE_FORCE_CUSTOM_DEFLATE === '1') {
  try { fakeWindow.CompressionStream = undefined; } catch (e) {}
  try { global.CompressionStream = undefined; } catch (e) {}
}

// Optional compression oracle capture.  Castle's outer ciphertext is the
// compressed signal frame XORed with its stream keystream.  Capturing the
// native Response.arrayBuffer() result lets the reverse-engineering harness
// compare that plaintext without changing the production path.
if (_process.env.CASTLE_COMPRESS_OUTPUT_FILE && typeof global.Response === 'function') {
  try {
    const _RealResponse = global.Response;
    class _CastleCapturedResponse extends _RealResponse {
      async arrayBuffer() {
        const bytes = await super.arrayBuffer();
        try { _fs.writeFileSync(_process.env.CASTLE_COMPRESS_OUTPUT_FILE, _Buffer.from(bytes)); } catch (e) {}
        return bytes;
      }
    }
    global.Response = _CastleCapturedResponse;
    fakeWindow.Response = _CastleCapturedResponse;
  } catch (e) { /* diagnostics only; leave native Response untouched */ }
}
Object.defineProperty(global, 'fetch', { value: fakeFetch, writable: true, configurable: true });
global.XMLHttpRequest = FakeXHR;
global.WebSocket = FakeWebSocket;
global.requestIdleCallback = fakeWindow.requestIdleCallback;
global.cancelIdleCallback = fakeWindow.cancelIdleCallback;
global.Worker = FakeWorker; global.SharedWorker = FakeSharedWorker;
global.Blob = FakeBlob; global.OffscreenCanvas = FakeOffscreenCanvas;
global.OfflineAudioContext = FakeOfflineAudioContext; global.webkitOfflineAudioContext = FakeOfflineAudioContext;
global.AudioContext = FakeAudioContext; global.webkitAudioContext = FakeAudioContext;
global.RTCPeerConnection = FakeRTCPeerConnection; global.webkitRTCPeerConnection = FakeRTCPeerConnection;
global.matchMedia = fakeMatchMedia; global.speechSynthesis = fakeSpeechSynthesis;
global.scheduler = fakeWindow.scheduler;
// 浏览器里全局作用域**就是** window，SDK 大量用裸标识符（requestAnimationFrame / screen /
// history / chrome / MutationObserver / localStorage …）。env.init() 只把 globalThis 这个
// *属性* 指到 fakeWindow，裸标识符仍沿 Node 真 global 的作用域链解析——少一个就 ReferenceError，
// 打死一整条采集链（2026-08-17 实测：缺 requestAnimationFrame → 12 个 oK 采集器全灭，
// 对应 9 路信号在 token 里整体缺席，比浏览器短了 300+ 字节）。这里把 fakeWindow 整体镜像过去。
const _GLOBAL_SKIP = new Set(['window', 'self', 'top', 'parent', 'globalThis',
  'process', 'Buffer', 'require', 'module', 'exports', '__dirname', '__filename']);
for (const k of Object.keys(fakeWindow)) {
  if (_GLOBAL_SKIP.has(k) || global[k] !== undefined) continue;
  try {
    Object.defineProperty(global, k, { value: fakeWindow[k], writable: true, configurable: true });
  } catch (e) { /* 只读的内建（如 undefined/NaN）跳过 */ }
}
// Castle calls getComputedStyle as a bare global; keep the fake browser API
// visible after env.init() has replaced globalThis with fakeWindow.
global.getComputedStyle = fakeWindow.getComputedStyle;
URL.createObjectURL = fakeURL.createObjectURL; URL.revokeObjectURL = fakeURL.revokeObjectURL;
fakeWindow.URL = URL;
// 恢复 Buffer：SDK 已加载完毕，此处只为让 Node 的 fetch/undici 惰性依赖不再崩（网络已被 stub）
Object.defineProperty(global, 'Buffer', { value: _Buffer, writable: true, configurable: true, enumerable: false });

// 对拍时可只替换 Castle 的 own-property 名称指纹，不给 fake DOM 真加一千多个
// 无行为的字段。真实浏览器会把 Window 的内建属性名纳入 fF() 哈希；
// CASTLE_OWN_KEYS_FILE 由干净页面采集器提供 {w,d,h,b} 四组名称。
let _ownKeyOverrides = null;
if (_process.env.CASTLE_OWN_KEYS_FILE) {
  try { _ownKeyOverrides = JSON.parse(_fs.readFileSync(_process.env.CASTLE_OWN_KEYS_FILE, 'utf8')); } catch (e) {}
}
if (!_ownKeyOverrides && _process.env.CASTLE_OWN_KEYS_JSON_B64) {
  try { _ownKeyOverrides = JSON.parse(_Buffer.from(_process.env.CASTLE_OWN_KEYS_JSON_B64, 'base64').toString('utf8')); } catch (e) {}
}
if (_ownKeyOverrides) {
  const _nativeOwnKeys = Object.getOwnPropertyNames;
  Object.getOwnPropertyNames = function (obj) {
    // Native Navigator exposes no own properties in Chrome; the proxy-backed
    // fake object otherwise leaks every stub field into Castle's key probe.
    if (obj === fakeNavigator || obj === navProxy) return [];
    if (obj === fakeWindow || obj === globalThis) return Array.isArray(_ownKeyOverrides.w) ? _ownKeyOverrides.w.slice() : _nativeOwnKeys(obj);
    if (obj === fakeDocument || obj === docProxy) return Array.isArray(_ownKeyOverrides.d) ? _ownKeyOverrides.d.slice() : _nativeOwnKeys(obj);
    if (obj === fakeDocument.documentElement) return Array.isArray(_ownKeyOverrides.h) ? _ownKeyOverrides.h.slice() : _nativeOwnKeys(obj);
    if (obj === fakeDocument.body) return Array.isArray(_ownKeyOverrides.b) ? _ownKeyOverrides.b.slice() : _nativeOwnKeys(obj);
    // Castle also fingerprints document.head.  Proxy identity can differ
    // from the raw fake node, so use the DOM tag as a stable fallback.
    try {
      const _tag = obj && typeof obj.tagName === 'string' ? obj.tagName.toLowerCase() : '';
      if (_tag === 'html' && Array.isArray(_ownKeyOverrides.h)) return _ownKeyOverrides.h.slice();
      if (_tag === 'body' && Array.isArray(_ownKeyOverrides.b)) return _ownKeyOverrides.b.slice();
      if (_tag === 'head' && Array.isArray(_ownKeyOverrides.head)) return _ownKeyOverrides.head.slice();
    } catch (e) {}
    return _nativeOwnKeys(obj);
  };
}

// Object.keys(window) is a separate Castle fingerprint input (MS="keys").
// A browser capture may provide the enumerable key order without materializing
// the full browser Window object in Node.
let _enumKeyOverrides = null;
if (_process.env.CASTLE_ENUM_KEYS_FILE) {
  try { _enumKeyOverrides = JSON.parse(_fs.readFileSync(_process.env.CASTLE_ENUM_KEYS_FILE, 'utf8')); } catch (e) {}
}
if (!_enumKeyOverrides && _process.env.CASTLE_ENUM_KEYS_JSON_B64) {
  try { _enumKeyOverrides = JSON.parse(_Buffer.from(_process.env.CASTLE_ENUM_KEYS_JSON_B64, 'base64').toString('utf8')); } catch (e) {}
}
if (_enumKeyOverrides && Array.isArray(_enumKeyOverrides.w)) {
  const _nativeObjectKeys = Object.keys;
  Object.keys = function (obj) {
    if (obj === fakeNavigator || obj === navProxy) return [];
    if (obj === fakeWindow || obj === globalThis) return _enumKeyOverrides.w.slice();
    return _nativeObjectKeys(obj);
  };
}

// 用追踪版 Promise 替换 SDK 捕获的 Promise（诊断 pending 挂起点）
if (_process.env.TRACK_PROMISE) { global.Promise = TP; fakeWindow.Promise = TP; }

// 加载 chunk（可用 CASTLE_FILE 指定打补丁的副本做诊断）。
// x-web 登录页当前还会加载一个独立的 ESM Castle UMD 包；用
// CASTLE_UMD_FILE + CASTLE_UMD_RUNTIME 可在同一补环境里做对拍，默认路径不变。
let _umdCastleModule = null;
if (_process.env.CASTLE_UMD_FILE) {
  const vm = require('vm');
  const castlePath = _path.resolve(_dirname, _process.env.CASTLE_UMD_FILE);
  const runtimePath = _path.resolve(
    _dirname, _process.env.CASTLE_UMD_RUNTIME || 'rolldown-runtime-XXLRXQBO.js');
  let runtimeSource = _fs.readFileSync(runtimePath, 'utf8');
  runtimeSource = runtimeSource.replace(
    /export\{d as a,f as i,o as n,u as o,c as r,s as t\};?\s*$/,
    'global.__castleUmdRuntime={a:d,i:f,n:o,o:u,r:c,t:s};');
  vm.runInThisContext(runtimeSource, { filename: runtimePath });
  let castleSource = _fs.readFileSync(castlePath, 'utf8');
  castleSource = castleSource.replace(
    /import\{t as e\}from["']\.\/rolldown-runtime-[^"']+["'];/,
    'var e=global.__castleUmdRuntime.t;');
  // The current x-web UMD no longer exposes the legacy `Rl=[]` collector.
  // Its request-token entry point closes over the signal object `$` and the
  // three state records [J8,GZ,KZ].  Keep an opt-in dump right before Iee()
  // serializes those records, so a browser capture can be compared without
  // changing the production path or printing the token.
  if (_process.env.CASTLE_UMD_PROFILE_DUMP) {
    const _umdDumpPath = _process.env.CASTLE_UMD_PROFILE_DUMP;
    const _umdDumpNeedle = '$9=function(){return[J8,GZ,KZ][D][_y][T]=Pd(),u(ip,O)[K]=ei(),Iee()};';
    const _umdDumpInject = '$9=function(){return[J8,GZ,KZ][D][_y][T]=Pd(),u(ip,O)[K]=ei(),(function(){try{var seen=[];function cp(v,d){if(v===null||v===void 0)return v;if(d>6)return "<depth>";var ty=typeof v;if(ty!=="object")return ty==="function"?"<function>":v;if(seen.indexOf(v)>=0)return "<cycle>";seen.push(v);if(Array.isArray(v)){var a=[];for(var i=0;i<v.length&&i<1200;i++)a.push(cp(v[i],d+1));return a}var o={};var ks=[];try{ks=Object.keys(v)}catch(e){}for(var j=0;j<ks.length&&j<1600;j++){try{o[ks[j]]=cp(v[ks[j]],d+1)}catch(e){o[ks[j]]="<error>"}}return o}var out={q9:cp(Q9,0),state:cp([J8,GZ,KZ],0),signals:cp($,0)};globalThis.__castleUmdDumpFs.writeFileSync(globalThis.__castleUmdDumpPath,JSON.stringify(out))}catch(e){try{globalThis.__castleUmdDumpFs.writeFileSync(globalThis.__castleUmdDumpPath+".err",String(e&&e.stack||e))}catch(_){}}})(),Iee()};';
    globalThis.__castleUmdDumpFs = _fs;
    globalThis.__castleUmdDumpPath = _umdDumpPath;
    if (DEBUG) console.error('UMD profile dump needle', castleSource.includes(_umdDumpNeedle), castleSource.indexOf(_umdDumpNeedle));
    castleSource = castleSource.replace(_umdDumpNeedle, _umdDumpInject);
  }
  // Optional full signal-vector replay for a byte-for-byte oracle.  This is
  // deliberately opt-in: production calls still collect locally, while a
  // captured browser vector can be applied after all async collectors settle
  // and immediately before the UMD serializer consumes `$`.
  if (_process.env.CASTLE_UMD_SIGNAL_OVERRIDES_FILE || _process.env.CASTLE_UMD_SIGNAL_OVERRIDES_JSON_B64) {
    let _umdOverrides = null;
    try {
      if (_process.env.CASTLE_UMD_SIGNAL_OVERRIDES_FILE) {
        _umdOverrides = JSON.parse(_fs.readFileSync(_process.env.CASTLE_UMD_SIGNAL_OVERRIDES_FILE, 'utf8'));
      } else {
        _umdOverrides = JSON.parse(_Buffer.from(_process.env.CASTLE_UMD_SIGNAL_OVERRIDES_JSON_B64, 'base64').toString('utf8'));
      }
    } catch (_) {}
    if (Array.isArray(_umdOverrides)) {
      globalThis.__castleUmdSignalOverrides = _umdOverrides;
      const _umdOverrideBody = 'if(globalThis.__castleUmdSignalOverrides){try{var __o=globalThis.__castleUmdSignalOverrides;for(var __i=0;__i<__o.length;__i++)$[__i]=__o[__i]}catch(__e){}}';
      // The profile bytes are produced as the argument to the promise chain;
      // apply the replay before that call (the later callback is too late for
      // the already-created Uint8Array).
      const _umdPreNeedle = 'return s}($))[$y](function(e){';
      const _umdPreInject = 'return s}((function(__v){' + _umdOverrideBody + ';return __v})($)))[\u0024y](function(e){';
      if (DEBUG) console.error('UMD signal pre-serialize needle', castleSource.includes(_umdPreNeedle), castleSource.indexOf(_umdPreNeedle));
      castleSource = castleSource.replace(_umdPreNeedle, _umdPreInject);
      const _umdOverrideNeedle = '))[$y](function(e){return h(SF,uk,j_,T)+bF+function(e){';
      const _umdOverrideDump = _process.env.CASTLE_UMD_FINAL_DUMP ? 'try{globalThis.__castleUmdDumpFs.writeFileSync(globalThis.__castleUmdFinalDumpPath,JSON.stringify($))}catch(__e2){}' : '';
      const _umdMetaDump = _process.env.CASTLE_UMD_META_DUMP ? 'try{var __m=$.map(function(v,i){var __ty=typeof v,__c=v&&v.constructor&&v.constructor.name||null,__tag="";try{__tag=Object.prototype.toString.call(v)}catch(__e3){}var __k=[];try{__k=Object.keys(v).slice(0,12)}catch(__e4){}return {i:i,ty:__ty,ctor:__c,tag:__tag,len:v&&typeof v.length==="number"?v.length:null,keys:__k}});globalThis.__castleUmdDumpFs.writeFileSync(globalThis.__castleUmdMetaDumpPath,JSON.stringify(__m))}catch(__e5){}' : '';
      const _umdOverrideInject = '))[$y](function(e){' + _umdOverrideBody + _umdOverrideDump + _umdMetaDump + 'return h(SF,uk,j_,T)+bF+function(e){';
      if (_process.env.CASTLE_UMD_FINAL_DUMP) {
        globalThis.__castleUmdDumpFs = _fs;
        globalThis.__castleUmdFinalDumpPath = _process.env.CASTLE_UMD_FINAL_DUMP;
      }
      if (_process.env.CASTLE_UMD_META_DUMP) {
        globalThis.__castleUmdDumpFs = _fs;
        globalThis.__castleUmdMetaDumpPath = _process.env.CASTLE_UMD_META_DUMP;
      }
      if (DEBUG) console.error('UMD signal override needle', castleSource.includes(_umdOverrideNeedle), castleSource.indexOf(_umdOverrideNeedle));
      castleSource = castleSource.replace(_umdOverrideNeedle, _umdOverrideInject);
    }
  }
  if (_process.env.CASTLE_UMD_FRAME_TRACE) {
    const _frameTracePath = _process.env.CASTLE_UMD_FRAME_TRACE;
    globalThis.__castleUmdDumpFs = _fs;
    globalThis.__castleUmdFrameTracePath = _frameTracePath;
    const _frameNeedle1 = 'if(t[0]=e,t[1]=lm[YC]()[ib](),t[2]=Pn(t[1]),t[3]=new TextEncoder().encode(t[2]),t[4]=function';
    const _frameInject1 = 'if(t[0]=e,(globalThis.__castleUmdFrameTrace={inputLen:e&&e.length||0,inputType:e&&e.constructor&&e.constructor.name||typeof e}),t[1]=lm[YC]()[ib](),t[2]=Pn(t[1]),t[3]=new TextEncoder().encode(t[2]),t[4]=function';
    const _frameNeedle2 = '}(t[0],t[1]),t[3][E]>Cb)return';
    const _frameInject2 = '}(t[0],t[1]),(globalThis.__castleUmdFrameTrace&&(globalThis.__castleUmdFrameTrace.t2Len=t[2]&&t[2].length||0,globalThis.__castleUmdFrameTrace.t3Len=t[3]&&t[3].length||0,globalThis.__castleUmdFrameTrace.t4Len=t[4]&&t[4].length||0,globalThis.__castleUmdDumpFs.writeFileSync(globalThis.__castleUmdFrameTracePath,JSON.stringify(globalThis.__castleUmdFrameTrace)))),t[3][E]>Cb)return';
    if (DEBUG) console.error('UMD frame needles', castleSource.includes(_frameNeedle1), castleSource.includes(_frameNeedle2));
    castleSource = castleSource.replace(_frameNeedle1, _frameInject1).replace(_frameNeedle2, _frameInject2);
  }
  castleSource = castleSource.replace(
    /export\s+default\s+t\(\);?\s*$/, 'global.__castleUmd=t();');
  if (_process.env.CASTLE_UMD_PATCHED_SOURCE) {
    try { _fs.writeFileSync(_process.env.CASTLE_UMD_PATCHED_SOURCE, castleSource); } catch (_) {}
  }
  vm.runInThisContext(castleSource, { filename: castlePath });
  _umdCastleModule = global.__castleUmd || null;
} else {
  const _castleFile = _process.env.CASTLE_FILE || 'castle.js';
  if (_process.env.CASTLE_RL_DUMP) {
    // One-shot introspection of the Castle signal registry before its custom
    // serializer packs it.  This is opt-in and leaves the production source
    // untouched; only shallow scalar/array lengths are persisted.
    const _vm = require('vm');
    fakeWindow.__castleDumpFs = _fs;
    fakeWindow.__castleDumpPath = _process.env.CASTLE_RL_DUMP;
    let _src = _fs.readFileSync(_path.resolve(_dirname, _castleFile), 'utf8');
    if (_process.env.CASTLE_RL_SET_TRACE) {
      const _tracePath = _process.env.CASTLE_RL_SET_TRACE;
      const _traceIdx = new Set(String(_process.env.CASTLE_RL_INDEX_TRACE || '')
        .split(',').map((x) => x.trim()).filter(Boolean));
      const _logShapes = _process.env.CASTLE_RL_LOG_SHAPES === '1';
      const _traceIdxJson = JSON.stringify(Array.from(_traceIdx));
      let _rlOverrides = {};
      try {
        if (_process.env.CASTLE_RL_OVERRIDES_JSON) {
          const _parsed = JSON.parse(_process.env.CASTLE_RL_OVERRIDES_JSON);
          if (_parsed && typeof _parsed === 'object') _rlOverrides = _parsed;
        }
      } catch (_) {}
      _src = _src.replace(
        'return nG(71,r,0)?r:d.X[n]=v.apply(null,arguments)}function x(',
        "var z=nG(71,r,0)?r:d.X[n]=v.apply(null,arguments);if(arguments[0]===47&&globalThis.__castleDumpFs&&globalThis.__castleRlSetTrace)globalThis.__castleDumpFs.appendFileSync(globalThis.__castleRlSetTrace,JSON.stringify({dec47:z})+'\\n');return z}function x("
      );
      fakeWindow.__castleRlSetTrace = _tracePath;
      // Rl is declared as `Rl=[]` in the minified chunk.  A diagnostic Proxy
      // records the collector stack for values whose shape is not scalar;
      // this is strictly opt-in and never affects the production path.
      _src = _src.replace('Rl=[]', 'Rl=new Proxy([],{set:function(t,p,v){try{if(Object.prototype.hasOwnProperty.call(' + JSON.stringify(_rlOverrides) + ',String(p)))v=' + JSON.stringify(_rlOverrides) + '[String(p)];if(globalThis.__castleDumpFs&&globalThis.__castleRlSetTrace&&(new Set(' + _traceIdxJson + ').has(String(p))||(' + _logShapes + '&&(Array.isArray(v)||typeof v==="object")))){globalThis.__castleDumpFs.appendFileSync(globalThis.__castleRlSetTrace,JSON.stringify({i:String(p),t:Array.isArray(v)?"array":typeof v,c:v&&v.constructor&&v.constructor.name,p:Object.prototype.toString.call(v),l:Array.isArray(v)?v.length:0,a:Array.isArray(v)?v.slice(0,8):null,v:(typeof v==="number"||typeof v==="boolean"||v===null?v:undefined),s:(typeof v==="string"?v.slice(0,160):null),st:(new Error()).stack})+"\\n");}}catch(e){};return Reflect.set(t,p,v)}})');
      _src = _src.replace('}function nG(', '}var __castle_nW0=nW;nW=function(){var z=__castle_nW0.apply(this,arguments);try{if(globalThis.__castleDumpFs&&globalThis.__castleRlSetTrace&&Array.isArray(z)){globalThis.__castleDumpFs.appendFileSync(globalThis.__castleRlSetTrace,JSON.stringify({nw:Array.from(arguments).slice(0,3).map(function(v){return Array.isArray(v)?"array":typeof v}),mode:arguments[0],a:z.slice(0,8),st:(new Error()).stack})+"\\n");}}catch(e){}return z};function nG(');
      _src = _src.replace('}function nW(', '}var __castle_nS0=nS;nS=function(){var z=__castle_nS0.apply(this,arguments);try{if(globalThis.__castleDumpFs&&globalThis.__castleRlSetTrace&&Array.isArray(z)){globalThis.__castleDumpFs.appendFileSync(globalThis.__castleRlSetTrace,JSON.stringify({ns:Array.from(arguments).slice(0,3).map(function(v){return Array.isArray(v)?"array":typeof v}),mode:arguments[0],a:z.slice(0,8),st:(new Error()).stack})+"\\n");}}catch(e){}return z};function nW(');
      _src = _src.replace('}function nZ(', '}var __castle_nG0=nG;nG=function(){var z=__castle_nG0.apply(this,arguments);try{if(globalThis.__castleDumpFs&&globalThis.__castleRlSetTrace&&Array.isArray(z)){var q=arguments[1];globalThis.__castleDumpFs.appendFileSync(globalThis.__castleRlSetTrace,JSON.stringify({ng:Array.from(arguments).slice(0,3).map(function(v){return Array.isArray(v)?"array":typeof v}),mode:arguments[0],arg1:Array.isArray(q)?q.slice(0,8):(q&&typeof q==="object"?Object.keys(q).slice(0,8):q),a:z.slice(0,8),st:(new Error()).stack})+"\\n");}}catch(e){}return z};function nZ(');
      // e6 classifies a property on an object as scalar/function/missing.  The
      // Re() collector uses it for window.performance; if our fake object has
      // the wrong shape it takes its fallback branch and all downstream timing
      // signals collapse to the same constant.  Log only the relevant property
      // ids to avoid producing a multi-megabyte trace.
      _src = _src.replace('}function e7(', '}var __castle_e60=e6;e6=function(){var q=arguments[0],r=arguments[1],z=__castle_e60.apply(this,arguments);try{if(globalThis.__castleDumpFs&&globalThis.__castleRlSetTrace&&(q===globalThis||q===globalThis.performance)){var d={e6r:r,qt:typeof q,qc:q&&q.constructor&&q.constructor.name,qp:Object.prototype.toString.call(q),qk:q&&typeof q==="object"?Object.keys(q).slice(0,24):null,zt:Array.isArray(z)?z.slice(0,4):z};globalThis.__castleDumpFs.appendFileSync(globalThis.__castleRlSetTrace,JSON.stringify(d)+"\\n");}}catch(e){}return z};function e7(');
      for (const _fn of ['ix','nz','Y','t$','F','L','h','nH','G','tU','tq','nw','N_']) {
        const _needleFn = 'function ' + _fn + '(n){';
        const _injectFn = _needleFn + 'try{if(globalThis.__castleDumpFs&&globalThis.__castleRlSetTrace){var q=n;globalThis.__castleDumpFs.appendFileSync(globalThis.__castleRlSetTrace,JSON.stringify({fn:' + JSON.stringify(_fn) + ',t:typeof q,v:typeof q==="number"?q:null,c:q&&q.constructor&&q.constructor.name,p:Object.prototype.toString.call(q),a:Array.isArray(q)?q.slice(0,8):null,k:q&&typeof q==="object"?Object.keys(q).slice(0,12):null,st:(new Error()).stack})+"\\n");}}catch(e){};';
        _src = _src.replace(_needleFn, _injectFn);
      }
      // `cx` is the final little-endian/base64 encoder used by the dense
      // browser probes around Rl[569..631].  Opt-in tracing records its raw
      // input and encoded output so the local probe can be matched against a
      // browser capture without changing normal token generation.
      if (_process.env.CASTLE_CX_TRACE) {
        const _cxPath = _process.env.CASTLE_CX_TRACE;
        _src = _src.replace(
          'function cx(n){',
          'function cx(n){try{if(globalThis.__castleDumpFs)globalThis.__castleDumpFs.appendFileSync(' +
          JSON.stringify(_cxPath) +
          ',JSON.stringify({n:n,t:typeof n,st:(new Error()).stack})+"\\n");}catch(e){}'
        );
      }
    }
    // The current Castle bundle replaced the old xorshift stream with a
    // larger obfuscated byte-wise mixer.  Keep an opt-in trace point at the
    // exact payload-encryption function so we can port the arithmetic without
    // logging the token itself.  The trace contains only scalar state,
    // lengths, and short SHA-256 digests of typed-array fields.
    if (_process.env.CASTLE_CIPHER_TRACE) {
      const _cipherTracePath = _process.env.CASTLE_CIPHER_TRACE;
      globalThis.__castleCipherTraceFs = _fs;
      globalThis.__castleCipherTraceBuffer = _Buffer;
      globalThis.__castleCipherTraceCrypto = nodeCrypto;
      const _cipherNeedle = 'r[4]=function(n,r){var t=[];for(t[0]=[],t[1]=';
      const _cipherInject = 'r[4]=function(n,r){try{globalThis.__castleDumpFs&&globalThis.__castleDumpFs.appendFileSync(' + JSON.stringify(_cipherTracePath) + ',\'entered\\n\')}catch(e){};var t=[];globalThis.__castleCipherTrace=t;globalThis.__castleCipherBytes=[];try{globalThis.__castleCipherConsts={K5,s4,D5,bw,bN,ba,qa,sT,b0,qw,sq,qi,vG,vE,w9,v8,pI,p4,bO,OT,yH,Ky,b1,yh,OZ,bq,bv,bn,bd,bo,y$,sE,sR,a_,wE,KR,pO,py,Ot,pN,pv,sH,bK,m7,yC,bV,D3,AU,qd,ss,b5,yS,y3,bU,DT,pV,bQ,bb,pd,l9,yU,yG,by,a1,wM,w6,w8,bR,sX,DV,Ci,sy,sh}}catch(e){};for(t[0]=[],t[1]=';
      if (DEBUG) console.error('cipher trace needle', _src.includes(_cipherNeedle), _src.indexOf(_cipherNeedle));
      _src = _src.replace(_cipherNeedle, _cipherInject);
      const _cipherReturnNeedle = 't[4]}(r[0],r[1]),r[3][l7]';
      const _cipherReturnInject = 't[4]}(r[0],r[1]),(function(){try{const q=globalThis.__castleCipherTrace;const clean=(v)=>{if(v&&typeof v!==\'function\'&&typeof v.length===\'number\'&&typeof v!==\'string\'){const b=globalThis.__castleCipherTraceBuffer.from(v.buffer||v,v.byteOffset||0,v.byteLength||v.length);return {kind:v.constructor&&v.constructor.name||\'array\',length:v.length,sha256:globalThis.__castleCipherTraceCrypto.createHash(\'sha256\').update(b).digest(\'hex\'),head:b.subarray(0,16).toString(\'hex\')}}if(typeof v===\'number\'||typeof v===\'string\'||typeof v===\'boolean\'||v===null)return v;if(v===undefined)return null;return {kind:typeof v}};globalThis.__castleCipherTraceFs.writeFileSync(' + JSON.stringify(_cipherTracePath) + ',JSON.stringify({consts:globalThis.__castleCipherConsts||null,init:globalThis.__castleCipherInit||null,bytes:globalThis.__castleCipherBytes||null,slots:q?q.map(clean):null,input:q&&clean(q[2]),random:q&&clean(q[1]),output:q&&clean(q[4])}))}catch(e){try{globalThis.__castleDumpFs&&globalThis.__castleDumpFs.appendFileSync(' + JSON.stringify(_cipherTracePath) + ',\'error:\'+String(e)+\'\\n\')}catch(_){}}})(),r[3][l7]';
      if (DEBUG) console.error('cipher return needle', _src.includes(_cipherReturnNeedle), _src.indexOf(_cipherReturnNeedle));
      _src = _src.replace(_cipherReturnNeedle, _cipherReturnInject);
      _src = _src.replace(
        't[53]=nW(ww,t[46],bO,pg,OT,pA,yH,pg,Ky,l8,l8),t[54]=l8',
        't[53]=nW(ww,t[46],bO,pg,OT,pA,yH,pg,Ky,l8,l8),globalThis.__castleCipherInit={t46:t[46],t50:t[50],t51:t[51],t52:t[52],t53:t[53],t22:t[22],t23:t[23],t41:t[41],t42:t[42]},t[54]=l8'
      );
      _src = _src.replace(
        '),t[4][pB+t[54]]=',
        '),globalThis.__castleCipherBytes&&t[54]<8&&globalThis.__castleCipherBytes.push({i:t[54],b:t[55],s:t[53]}),t[4][pB+t[54]]='
      );
    }
    // Optional inner-frame trace.  Keep the values local and digest them by
    // default: this boundary contains the signal JSON before compression.
    // CASTLE_INNER_TRACE_RAW is deliberately opt-in for local reverse work.
    if (_process.env.CASTLE_INNER_TRACE) {
      const _innerTracePath = _process.env.CASTLE_INNER_TRACE;
      const _innerTraceRaw = _process.env.CASTLE_INNER_TRACE_RAW === '1';
      const _innerNeedle = 'r[1]=nS(vL)[sY](),r[2]=tg(r[1]),r[3]=(new TextEncoder).encode(r[2]),';
      const _innerInject = 'r[1]=nS(vL)[sY](),r[2]=tg(r[1]),(function(){try{const a=String(r[1]),b=String(r[2]);const h=(x)=>globalThis.__castleTraceCrypto.createHash(\'sha256\').update(x).digest(\'hex\');globalThis.__castleInnerTrace={r1:{length:a.length,sha256:h(a),head:a.slice(0,64),tail:a.slice(-64)},r2:{length:b.length,sha256:h(b),head:b.slice(0,128),tail:b.slice(-128)}};' + (_innerTraceRaw ? 'globalThis.__castleInnerTrace.raw=b;' : '') + 'globalThis.__castleTraceFs.writeFileSync(' + JSON.stringify(_innerTracePath) + ',JSON.stringify(globalThis.__castleInnerTrace))}catch(e){try{globalThis.__castleTraceFs.writeFileSync(' + JSON.stringify(_innerTracePath + '.err') + ',String(e&&e.stack||e))}catch(_){}}})(),r[3]=(new TextEncoder).encode(r[2]),';
      globalThis.__castleTraceFs = _fs;
      globalThis.__castleTraceCrypto = nodeCrypto;
      fakeWindow.__castleTraceFs = _fs;
      fakeWindow.__castleTraceCrypto = nodeCrypto;
      try { _fs.writeFileSync(_innerTracePath + '.needle', JSON.stringify({found: _src.includes(_innerNeedle), index: _src.indexOf(_innerNeedle), file: _castleFile})); } catch (e) {}
      _src = _src.replace(_innerNeedle, _innerInject);
    }
    // Capture the serializer output immediately before the bundle's
    // CompressionStream/custom-deflate boundary.  This is opt-in and writes
    // only a digest unless CASTLE_RAW_SIGNAL_RAW=1 is explicitly requested.
    if (_process.env.CASTLE_RAW_SIGNAL_FILE) {
      const _rawSignalPath = _process.env.CASTLE_RAW_SIGNAL_FILE;
      const _rawSignalRaw = _process.env.CASTLE_RAW_SIGNAL_RAW === '1';
      const _rawStart = '_C(function(n){function r(n){';
      const _rawStartInject = '_C((function(q){try{const b=globalThis.__castleTraceBuffer.from(q.buffer||q,q.byteOffset||0,q.byteLength||q.length);const z={length:q.length,sha256:globalThis.__castleTraceCrypto.createHash(\'sha256\').update(b).digest(\'hex\'),head:b.subarray(0,32).toString(\'hex\')};' + (_rawSignalRaw ? 'z.raw=Array.from(b);' : '') + 'globalThis.__castleTraceFs.writeFileSync(' + JSON.stringify(_rawSignalPath) + ',JSON.stringify(z))}catch(e){try{globalThis.__castleTraceFs.writeFileSync(' + JSON.stringify(_rawSignalPath + '.err') + ',String(e&&e.stack||e))}catch(_){}}return q})(function(n){function r(n){';
      globalThis.__castleTraceFs = _fs;
      globalThis.__castleTraceCrypto = nodeCrypto;
      globalThis.__castleTraceBuffer = _Buffer;
      fakeWindow.__castleTraceFs = _fs;
      fakeWindow.__castleTraceCrypto = nodeCrypto;
      fakeWindow.__castleTraceBuffer = _Buffer;
      _src = _src.replace(_rawStart, _rawStartInject);
      _src = _src.replace('}(Rl))[pm]', '}(Rl)))[pm]');
    }
    if (_process.env.CASTLE_COMPRESS_RESULT_FILE) {
      const _compressResultPath = _process.env.CASTLE_COMPRESS_RESULT_FILE;
      const _compressResultInject = '}(Rl))[pm](function(n){try{const b=globalThis.__castleTraceBuffer.from(n.buffer||n,n.byteOffset||0,n.byteLength||n.length);globalThis.__castleTraceFs.writeFileSync(' + JSON.stringify(_compressResultPath) + ',b)}catch(e){try{globalThis.__castleTraceFs.writeFileSync(' + JSON.stringify(_compressResultPath + '.err') + ',String(e&&e.stack||e))}catch(_){}}return x(qI';
      globalThis.__castleTraceFs = _fs;
      globalThis.__castleTraceBuffer = _Buffer;
      fakeWindow.__castleTraceFs = _fs;
      fakeWindow.__castleTraceBuffer = _Buffer;
      _src = _src.replace('}(Rl))[pm](function(n){return x(qI', _compressResultInject);
      _src = _src.replace('}(Rl)))[pm](function(n){return x(qI', _compressResultInject.replace('}(Rl))[pm]', '}(Rl)))[pm]'));
    }
    if (_process.env.CASTLE_DEFLATE_TRACE) {
      const _deflateTracePath = _process.env.CASTLE_DEFLATE_TRACE;
      const _deflateTraceNeedle = 'return r(X,I[256],g[256]),X.finish()';
      const _deflateTraceInject = 'return r(X,I[256],g[256]),(function(){try{globalThis.__castleTraceFs.writeFileSync(' + JSON.stringify(_deflateTracePath) + ',JSON.stringify({tokens:p,lit:g,dist:M,cl:z,runs:Q,litCodes:I,distCodes:F,clCodes:P}))}catch(e){try{globalThis.__castleTraceFs.writeFileSync(' + JSON.stringify(_deflateTracePath + '.err') + ',String(e&&e.stack||e))}catch(_){}}})(),X.finish()';
      globalThis.__castleTraceFs = _fs;
      fakeWindow.__castleTraceFs = _fs;
      _src = _src.replace(_deflateTraceNeedle, _deflateTraceInject);
    }
    const _needle = '_C(function(n){function r(n){';
    const _inject = '_C(function(n){try{const q=Array.isArray(n)?n.map((v,i)=>({i,t:Array.isArray(v)?"array":typeof v,c:v&&v.constructor&&v.constructor.name,p:Object.prototype.toString.call(v),l:Array.isArray(v)?v.length:(v&&typeof v==="object"?Object.keys(v).length:0),a:Array.isArray(v)?v.slice(0,8):null,v:(typeof v==="number"||typeof v==="boolean"||v===null?v:undefined),s:(typeof v==="string"?v.slice(0,120):null)})):null;globalThis.__castleDumpFs.writeFileSync(globalThis.__castleDumpPath,JSON.stringify(q));}catch(e){};function r(n){';
    _src = _src.replace(_needle, _inject);
    _vm.runInThisContext(_src, { filename: _castleFile });
  } else {
    require('./' + _castleFile);
  }
}
if (DEBUG) console.log('captured module ids:', Object.keys(captured));

// ---------- 最小 webpack require ----------
const cache = {};
function __webpack_require__(id) {
  if (cache[id]) return cache[id].exports;
  const m = cache[id] = { id, loaded: false, exports: {} };
  if (!captured[id]) throw new Error('missing module ' + id);
  captured[id].call(m.exports, m, m.exports, __webpack_require__);
  m.loaded = true;
  return m.exports;
}
__webpack_require__.o = (o, p) => Object.prototype.hasOwnProperty.call(o, p);
__webpack_require__.d = (ex, a, b) => {
  if (typeof a === 'string') { if (!__webpack_require__.o(ex, a)) Object.defineProperty(ex, a, { enumerable: true, get: b }); }
  else for (const k in a) if (__webpack_require__.o(a, k) && !__webpack_require__.o(ex, k)) Object.defineProperty(ex, k, { enumerable: true, get: a[k] });
};
__webpack_require__.r = (ex) => {
  if (typeof Symbol !== 'undefined' && Symbol.toStringTag) Object.defineProperty(ex, Symbol.toStringTag, { value: 'Module' });
  Object.defineProperty(ex, '__esModule', { value: true });
};
__webpack_require__.n = (m) => { const g = m && m.__esModule ? () => m.default : () => m; __webpack_require__.d(g, { a: g }); return g; };
__webpack_require__.t = function (value, mode) {
  if (mode & 1) value = __webpack_require__(value);
  if (mode & 8) return value;
  if (mode & 4 && typeof value === 'object' && value && value.__esModule) return value;
  const ns = Object.create(null);
  __webpack_require__.r(ns);
  Object.defineProperty(ns, 'default', { enumerable: true, value });
  if (mode & 2 && typeof value !== 'string') for (const k in value) __webpack_require__.d(ns, k, ((kk) => () => value[kk])(k));
  return ns;
};
__webpack_require__.e = () => Promise.resolve();
__webpack_require__.m = captured;
__webpack_require__.c = cache;
__webpack_require__.p = '';

(async () => {
  let _ok = false;
  const PK = _process.env.CASTLE_PK || 'pk_AvRa79bHyJSYSQHnRpcVtzyxetSvFerx';
  const withTimeout = (p, ms, label) => _RealPromise.race([
    _RealPromise.resolve(p),
    new _RealPromise((_, rej) => setTimeout(() => rej(new Error('timeout ' + ms + 'ms @ ' + label)), ms)),
  ]);
  try {
    // The Castle chunk is rebuilt frequently and its webpack module id is not
    // stable.  Prefer an explicitly supplied id (refresh-castle discovers it)
    // and otherwise fall back to the legacy id or the only captured module.
    const capturedIds = Object.keys(captured);
    const configuredModuleId = _process.env.CASTLE_MODULE_ID;
    const moduleId = configuredModuleId ||
      (captured[321128] ? '321128' : (capturedIds.length === 1 ? capturedIds[0] : '321128'));
    const mod = _umdCastleModule || __webpack_require__(Number(moduleId));
    if (DEBUG) {
      console.log('321128 export keys:', Object.keys(mod), '__esModule=', mod.__esModule);
      console.log('typeof configure:', typeof mod.configure);
    }
    if (typeof mod.configure === 'function') {
      const sdk = await withTimeout(mod.configure({ pk: PK }), 5000, 'configure');
      if (DEBUG) console.log('configure resolved. sdk keys:', sdk && Object.keys(sdk), 'typeof createRequestToken:', sdk && typeof sdk.createRequestToken);
      if (sdk && typeof sdk.createRequestToken === 'function') {
        // 给 idle 预生成 + 慢采集器（WebRTC ICE 等）一点时间；CASTLE_WARMUP 可调
        await new _RealPromise((r) => setTimeout(r, Number(_process.env.CASTLE_WARMUP || 200)));
        // 可选的离线交互回放：登录页的 Castle 会把输入/焦点等事件计入
        // token。生产默认不伪造事件；逆向对拍时用逗号分隔的类型回放，
        // 例如 CASTLE_EVENTS=focus,input,keydown,keyup,blur。
        if (_process.env.CASTLE_EVENTS) {
          const now = Date.now();
          const target = { tagName: 'INPUT', nodeName: 'INPUT', type: 'text',
            name: 'username_or_email', id: 'username_or_email', value: '',
            isContentEditable: false, getAttribute: () => null };
          const base = { isTrusted: true, bubbles: true, cancelable: true,
            defaultPrevented: false, target, currentTarget: target,
            composedPath: () => [target], timeStamp: now,
            clientX: 200, clientY: 200, pageX: 200, pageY: 200,
            button: 0, buttons: 0, key: 'a', code: 'KeyA', keyCode: 65,
            which: 65, inputType: 'insertText', data: 'a' };
          for (const type of String(_process.env.CASTLE_EVENTS).split(',').map((x) => x.trim()).filter(Boolean)) {
            const ev = Object.assign({}, base, { type, timeStamp: now });
            fakeDocument.dispatchEvent(ev); fakeWindow.dispatchEvent(ev);
          }
        }
        _pidAtToken = _pid;
        if (_process.env.CASTLE_BTOA_TRACE && !_process.env.CASTLE_BTOA_NO_RESET) {
          fakeWindow.__btoa = [];
          if (_process.env.CASTLE_BTOA_STACK) fakeWindow.__btoaStacks = [];
        }
        // 默认一次调用；CASTLE_COUNT 仅用于对拍同一 SDK 实例连续调用，
        // 验证 configure/collector 是否在 begin→password 之间保留状态。
        const tokenCount = Math.max(1, Number(_process.env.CASTLE_COUNT || 1) || 1);
        for (let tokenIndex = 0; tokenIndex < tokenCount; tokenIndex++) {
          const p = sdk.createRequestToken();
          if (DEBUG) console.log('sync return:', typeof p, 'thenable=', !!(p && typeof p.then === 'function'), 'ctor=', p && p.constructor && p.constructor.name);
          if (_process.env.TRACK_PROMISE) { const meta = _promiseMeta.get(p); console.log('RETURNED PROMISE created at:\n' + (meta ? meta.stack.split('\n').slice(0, 7).join('\n') : 'not a TP')); }
          if (DEBUG && p && typeof p.then === 'function') { p.then((v) => console.log('SETTLED resolve len=', v && v.length), (e) => console.log('SETTLED reject:', e && (e.message || e))); }
          const tok = await withTimeout(p, Number(_process.env.TOKEN_TIMEOUT || 6000), 'createRequestToken');
          if (DEBUG) {
            console.log('TOKEN typeof:', typeof tok, 'len:', tok && tok.length, 'index:', tokenIndex);
            console.log('TOKEN head:', typeof tok === 'string' ? tok.slice(0, 100) : tok);
          }
          if (typeof tok === 'string') {
            _process.stdout.write('__CASTLE_TOKEN__=' + tok + '\n');
            _ok = true;
          } else {
            _process.stderr.write('FATAL: createRequestToken 未返回字符串（typeof=' + typeof tok + '）\n');
          }
        }
        if (DEBUG) {
          console.log('net calls:', JSON.stringify(fakeFetch._log.slice(0, 5)), 'xhr:', JSON.stringify(FakeXHR._log.slice(0, 5)));
          console.log('workers:', FakeWorker._instances.length, 'posts:', FakeWorker._posts.length);
        }
      } else {
        _process.stderr.write('FATAL: configure 后无 createRequestToken（SDK 结构可能变了）\n');
      }
    } else {
      _process.stderr.write('FATAL: 模块 321128 无 configure（castle.js 结构可能变了）\n');
    }
  } catch (e) {
    const _msg = e && e.stack ? e.stack.split('\n').slice(0, DEBUG ? 8 : 3).join('\n') : String(e);
    _process.stderr.write('FATAL: ' + _msg + '\n');
  } finally {
   if (DEBUG) {
    console.log('\n===== WORKER DIAG =====');
    console.log('dedicated workers:', FakeWorker._instances.length, 'posts to workers:', FakeWorker._posts.length);
    console.log('posts:', JSON.stringify(FakeWorker._posts.slice(0, 6)));
    console.log('worker mainReceived:', JSON.stringify(FakeWorker._mainReceived));
    console.log('worker errors:', JSON.stringify(FakeWorker._errors.slice(0, 6)));
    console.log('sharedWorkers:', FakeSharedWorker._instances.length, 'srcLens:', FakeSharedWorker._instances.map((w) => (w._src && w._src._text || '').length));
    console.log('shared mainReceived tags:', JSON.stringify(FakeSharedWorker._mainReceived), 'shared errors:', JSON.stringify(FakeSharedWorker._errors.slice(0, 4)));
    console.log('rng calls:', fakeCrypto._rng, 'subtle calls:', JSON.stringify(_subtleLog.slice(0, 10)));
    console.log('getComputedStyle 未覆盖的属性:', JSON.stringify([..._computedMiss]));
    console.log('getComputedStyle calls:', _computedCallIndex);
    console.log('btoa calls:', (fakeWindow.__btoa || []).length, 'lens:', JSON.stringify((fakeWindow.__btoa || []).slice(-5)));
      if (_process.env.CASTLE_BTOA_TRACE) {
        console.log('btoa head:', JSON.stringify((fakeWindow.__btoa || []).slice(0, 30)));
        console.log('btoa tail:', JSON.stringify((fakeWindow.__btoa || []).slice(-30)));
        if (_process.env.CASTLE_BTOA_JSON) console.log('btoa json:', JSON.stringify(fakeWindow.__btoa || []));
        if (_process.env.CASTLE_BTOA_FILE) {
          try { _fs.writeFileSync(_process.env.CASTLE_BTOA_FILE, JSON.stringify(fakeWindow.__btoa || [])); } catch (e) {}
        }
      if (_process.env.CASTLE_BTOA_FULL) {
        console.log('btoa full:', JSON.stringify(fakeWindow.__btoa || []));
      }
      if (_process.env.CASTLE_BTOA_FULL_B64) {
        console.log('btoa full b64:', _Buffer.from(JSON.stringify(fakeWindow.__btoa || []), 'utf8').toString('base64'));
      }
      if (_process.env.CASTLE_BTOA_STACK) {
        try { _fs.writeFileSync(_process.env.CASTLE_BTOA_STACK, JSON.stringify(fakeWindow.__btoaStacks || [], null, 2)); } catch (e) {}
      }
    }
    console.log('fetch calls:', JSON.stringify(fakeFetch._log.slice(0, 8)), 'xhr calls:', JSON.stringify(FakeXHR._log.slice(0, 8)));
    try {
      const handles = _process._getActiveHandles ? _process._getActiveHandles() : [];
      const reqs = _process._getActiveRequests ? _process._getActiveRequests() : [];
      console.log('active handles:', handles.map((h) => h && h.constructor && h.constructor.name), 'active reqs:', reqs.length);
    } catch (e) { console.log('handles err', String(e)); }
    if (_process.env.TRACK_PROMISE) {
      const pend = [];
      for (const [id, e] of _promiseLog) if (e.settled === null && id > _pidAtToken) pend.push({ id, ...e });
      const bySig = new Map();
      for (const e of pend) {
        const frames = (e.stack || '').split('\n');
        const cf = frames.find((l) => l.includes('castle')) || frames.find((l) => l.includes('run.js') && !l.includes('new TP')) || 'unknown';
        const sig = cf.trim();
        bySig.set(sig, (bySig.get(sig) || 0) + 1);
      }
      console.log('\n===== TOKEN-TIME PENDING PROMISES (', pend.length, 'created after pid', _pidAtToken, ') =====');
      const sorted = [...bySig.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
      for (const [sig, n] of sorted) console.log(`  x${n}  ${sig}`);
      console.log('\n--- sample full stacks (token-time) ---');
      pend.slice(0, 4).forEach((e, i) => console.log(`[pend ${i} id=${e.id}]\n` + (e.stack || '').split('\n').slice(0, 7).join('\n')));
      // 找最大的那次 Promise.all，报告仍 pending 的元素及其创建位置
      let biggest = null;
      for (const a of TP._allCalls) if (!biggest || a.length > biggest.length) biggest = a;
      if (biggest) {
        console.log('\n===== biggest Promise.all: ' + biggest.length + ' elements =====');
        let stuck = 0;
        biggest.forEach((el, i) => {
          const meta = _promiseMeta.get(el);
          const log = meta && _promiseLog.get(meta.id);
          const settled = log ? log.settled : '(untracked)';
          if (settled === null || settled === '(untracked)') {
            stuck++;
            const raw = (meta && meta.stack || '').split('\n').slice(1, 5).map((l) => l.trim()).join(' <- ');
            console.log(`  [${i}] PENDING id=${meta && meta.id}: ${raw}`);
          }
        });
        console.log('  stuck count:', stuck, '/', biggest.length);
      }
    }
    FakeSharedWorker._instances.forEach((w, i) => { const s = (w._src && w._src._text) || ''; if (s) { console.log(`\n--- shared[${i}] len=${s.length} ---`); console.log(s.slice(0, 900)); } });
    console.log('blob store size:', _blobStore.size);
    let idx = 0;
    for (const [u, b] of _blobStore) {
      const src = (b && b._text) || '';
      console.log(`--- blob[${idx}] ${u} len=${src.length} ---`);
      console.log(src.slice(0, 700));
      idx++;
      if (idx >= 4) break;
    }
    console.log('worker posts sample done');
   }
    _process.exit(_ok ? 0 : 1);
  }
})();
