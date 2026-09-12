// 맞춤법 검사 — 사람인+네이버+다음(문맥/통계 기반) + Hunspell(사전 기반, 오프라인) 다중 검사.
// 사람인(나라인포테크/부산대 계열 엔진)이 자판 위치 기반 오타(예: 안양하세요→안녕하세요)를
// 네이버·다음보다 잘 잡아서 우선으로 두고, 네이버·다음은 "안/않, 되/돼, 던지/든지"처럼
// 문맥상 틀린 표현을 보완적으로 잡아줌. 셋 다 공식 API가 아니라 예고 없이 끊길 수 있고,
// 너무 심하게 뭉개진 글자는 교정안 자체를 못 내놓을 때가 있음(이 경우 token과 suggestion이 같게 돌아옴).
// 그럴 때 Hunspell(오픈소스 한국어 사전, 파이어폭스/리브레오피스가 쓰는 것과 같은 엔진)로 한 번 더 사전에서
// 가장 가까운 단어를 찾아봄 — 네트워크 호출 없이 서버에 내장된 사전으로 동작해서 끊길 일이 없음.
// 다만 Hunspell은 "사전에 있는 단어인가"만 보므로 문맥은 모름 — 그래서 이 추정은 "guessed"로 표시해 구분함.
const { spellCheckByNAVER, spellCheckByDAUM } = require("hanspell");
const { loadModule } = require("hunspell-asm");
const fs = require("fs");
const path = require("path");

const MAX_LENGTH = 3000;
const TIMEOUT_MS = 8000;

function decodeEntities(s) {
  return String(s || "").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

async function checkSaramin(text) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch("https://www.saramin.co.kr/zf_user/tools/spell-check", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://www.saramin.co.kr/zf_user/tools/character-counter",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
      body: "content=" + encodeURIComponent(text),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json();
    if (!data || !data.result || !Array.isArray(data.word_list)) return { ok: true, errors: [] };
    const errors = data.word_list.map((w) => ({
      token: w.errorWord,
      suggestions: String(w.candWordList || "").split("|").map(decodeEntities).filter(Boolean),
      info: decodeEntities(w.helpMessage),
    }));
    return { ok: true, errors };
  } catch (e) {
    return { ok: false, errors: [] };
  }
}

let hunspellPromise = null;
function getHunspell() {
  if (!hunspellPromise) {
    hunspellPromise = loadModule().then((factory) => {
      const dictDir = path.dirname(require.resolve("dictionary-ko"));
      const affPath = factory.mountBuffer(fs.readFileSync(path.join(dictDir, "index.aff")), "ko.aff");
      const dicPath = factory.mountBuffer(fs.readFileSync(path.join(dictDir, "index.dic")), "ko.dic");
      return factory.create(affPath, dicPath);
    });
  }
  return hunspellPromise;
}

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

  const [saramin, naver, daum] = await Promise.all([
    checkSaramin(text),
    checkWith(spellCheckByNAVER, text),
    checkWith(spellCheckByDAUM, text),
  ]);

  if (!saramin.ok && !naver.ok && !daum.ok) {
    return jsonResponse(502, { status: "error", detail: "맞춤법 검사 서비스에 접속할 수 없어요." });
  }

  // 같은 단어를 여러 엔진이 동시에 지적하면 한 번만 남기고(자판 오타를 잘 잡는 사람인을 우선),
  // 텍스트 내 첫 등장 위치 순으로 정렬해 프런트의 순차 교정 로직이 어긋나지 않게 함.
  const seenTokens = new Set();
  const errors = [];
  [saramin.errors, naver.errors, daum.errors].forEach((list) => {
    list.forEach((err) => {
      if (!err || !err.token || seenTokens.has(err.token)) return;
      seenTokens.add(err.token);
      errors.push({ token: err.token, suggestions: err.suggestions, info: err.info });
    });
  });
  errors.sort((a, b) => text.indexOf(a.token) - text.indexOf(b.token));

  // 네이버·다음이 교정안을 못 내놓은 항목(suggestion===token)은 공백 없는 단어에 한해
  // Hunspell 사전에서 가장 가까운 단어를 찾아 "추정 교정"으로 보충함.
  const needsGuess = errors.filter((err) => {
    const suggestion = err.suggestions && err.suggestions[0];
    return (!suggestion || suggestion === err.token) && !/\s/.test(err.token);
  });
  if (needsGuess.length) {
    try {
      const hunspell = await getHunspell();
      needsGuess.forEach((err) => {
        const guesses = hunspell.suggest(err.token);
        if (guesses.length) {
          err.suggestions = [guesses[0]];
          err.guessed = true;
        }
      });
    } catch (e) {
      // Hunspell 로딩 실패해도 기존 결과는 그대로 반환
    }
  }

  return jsonResponse(200, { status: "ok", errors });
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
