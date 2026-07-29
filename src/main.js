import { Game } from './game.js';

function fail(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.classList.add('is-on');
}

function boot() {
  const host = document.getElementById('game-host');
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) {
      fail('这台设备/浏览器没有可用的 WebGL，无法运行 3D 场景。请换用较新的 Chrome / Safari / Edge。');
      return;
    }
    window.__game = new Game(host);
  } catch (err) {
    fail(`初始化失败：${err?.stack || err}`);
    console.error(err);
  }
}

addEventListener('error', (e) => {
  if (!window.__SKI_READY__) fail(`脚本错误：${e.message}`);
});

boot();
