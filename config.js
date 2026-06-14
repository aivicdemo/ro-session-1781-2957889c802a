// AIVIC Backend Configuration
// AIVIC_APP_URL 環境変数が設定されている場合は自動セットされます
// 未設定の場合: REPLACE_WITH_API_URL を AIVIC アプリの URL（例: https://your-app.amplifyapp.com）に書き換えてください

window.AIVIC_API_URL = "REPLACE_WITH_API_URL";
window.AIVIC_TABLES = {
  "受注データ検証結果": 0,
  "受注データ修正履歴": 1,
  "信頼度スコア": 2,
  "AI_OCR読込結果": 3,
  "音声ガイダンス記録": 4,
  "重複受注検出": 5,
  "チャネル間矛盾検出": 6,
  "連携承認フロー": 7,
  "承認者判定履歴": 8,
  "基幹システム連携ログ": 9,
  "操作履歴": 10,
  "クライアント情報": 11,
  "受注チャネル": 12,
  "修正対象優先度ランク": 13,
  "信頼度スコアしきい値設定": 14,
  "検証ルール定義": 15,
  "過去受注履歴": 16
};
