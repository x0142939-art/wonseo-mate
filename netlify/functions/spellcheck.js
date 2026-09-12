// 맞춤법 검사 — 네이버 맞춤법 검사 엔진을 이용하는 hanspell 라이브러리를 감싼 서버리스 함수.
// AI가 아니고 비용도 없지만, 공식 API가 아니라 예고 없이 끊길 수 있음.
const { spellCheckByNAVER } = require("hanspell");

const MAX_LENGTH = 3000;
const TIMEOUT_MS = 8000;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "POST only" };
  }

  let text;
  try {
    text = JSON.parse(event.body || "{}").text;
  } catch (e) {
    return jsonResponse(400, { status: "error", detail: "잘못된 요청이에요." });
  }

  if (!text || typeof text !== "string" || !text.trim()) {
    return jsonResponse(400, { status: "error", detail: "검사할 내용이 없어요." });
  }
  if (text.length > MAX_LENGTH) {
    return jsonResponse(400, { status: "error", detail: `한 번에 ${MAX_LENGTH}자까지만 검사할 수 있어요.` });
  }

  return new Promise((resolve) => {
    const errors = [];
    let settled = false;

    const finish = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    spellCheckByNAVER(
      text,
      TIMEOUT_MS,
      (data) => {
        if (Array.isArray(data)) errors.push(...data);
      },
      () => {
        finish(jsonResponse(200, { status: "ok", errors }));
      },
      (err) => {
        finish(jsonResponse(502, { status: "error", detail: String(err) }));
      }
    );
  });
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
