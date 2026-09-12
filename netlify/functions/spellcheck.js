// 맞춤법 검사 — 네이버+다음 맞춤법 검사 엔진을 같이 호출하는 hanspell 라이브러리를 감싼 서버리스 함수.
// 둘 다 AI가 아니고 비용도 없지만, 공식 API가 아니라 예고 없이 끊길 수 있음.
// 두 엔진을 같이 써서 한쪽이 놓친 오류를 다른 쪽이 잡아주거나, 한쪽이 막혀도 나머지 결과는 돌려줄 수 있게 함.
// (부산대 맞춤법 검사기도 검토했으나, 백엔드(nara-speller.co.kr)가 Cloudflare 봇 차단으로 서버 간 호출을 막아두어 연동 불가.)
const { spellCheckByNAVER, spellCheckByDAUM } = require("hanspell");

const MAX_LENGTH = 3000;
const TIMEOUT_MS = 8000;

function checkWith(fn, text) {
  return new Promise((resolve) => {
    const errors = [];
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ ok, errors });
    };
    fn(
      text,
      TIMEOUT_MS,
      (data) => {
        if (Array.isArray(data)) errors.push(...data);
      },
      () => finish(true),
      () => finish(false)
    );
  });
}

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

  const [naver, daum] = await Promise.all([
    checkWith(spellCheckByNAVER, text),
    checkWith(spellCheckByDAUM, text),
  ]);

  if (!naver.ok && !daum.ok) {
    return jsonResponse(502, { status: "error", detail: "맞춤법 검사 서비스에 접속할 수 없어요." });
  }

  // 같은 단어를 두 엔진이 동시에 지적하면 한 번만 남기고(먼저 온 네이버 쪽을 우선),
  // 텍스트 내 첫 등장 위치 순으로 정렬해 프런트의 순차 교정 로직이 어긋나지 않게 함.
  const seenTokens = new Set();
  const errors = [];
  [naver.errors, daum.errors].forEach((list) => {
    list.forEach((err) => {
      if (!err || !err.token || seenTokens.has(err.token)) return;
      seenTokens.add(err.token);
      errors.push({ token: err.token, suggestions: err.suggestions, info: err.info });
    });
  });
  errors.sort((a, b) => text.indexOf(a.token) - text.indexOf(b.token));

  return jsonResponse(200, { status: "ok", errors });
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
