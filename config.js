// AIVIC Backend Configuration
// AIVIC_APP_URL 環境変数が設定されている場合は自動セットされます
// 未設定の場合: REPLACE_WITH_API_URL を AIVIC アプリの URL（例: https://your-app.amplifyapp.com）に書き換えてください

window.AIVIC_API_URL = "REPLACE_WITH_API_URL";
window.AIVIC_TABLES = {
  "受注データ検証結果": 0,
  "受注データ修正履歴": 1,
  "信頼度スコア": 2,
  "AI_OCR読み込み結果": 3,
  "音声ガイダンス記録": 4,
  "チャネル情報": 5,
  "重複受注検出結果": 6,
  "チャネル間矛盾検出結果": 7,
  "入力漏れ検出結果": 8,
  "連携承認フロー": 9,
  "承認者判定履歴": 10,
  "基幹システム連携ログ": 11,
  "クライアント情報": 12,
  "修正対象優先度リスト": 13,
  "操作履歴": 14
};
