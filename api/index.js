'use strict';

// Vercel 用のエントリーポイント。/api/* へのリクエストはすべてここに届く（vercel.json 参照）。
// 画面（public/）は Vercel が静的ファイルとして配信する。
// 自動アーカイブは API にアクセスがあるたびに判定する（常駐タイマーは Vercel では動かないため）。
const { createApp } = require('../server');
const { Store } = require('../lib/store');
const { backendFromEnv } = require('../lib/backends');

let handler;

module.exports = async (req, res) => {
  if (!handler) {
    try {
      handler = createApp(new Store(backendFromEnv()), { serveFiles: false });
    } catch (err) {
      console.error(err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: err.message }));
    }
  }
  return handler(req, res);
};
