// ============================================================
// script.js - 實驗主邏輯
// 實驗設計：2（錯誤方向）× 3（錯誤率）= 6 組 Between-subjects
//   方向：One-way（只有 false_negative）vs Two-way（false_negative + false_positive）
//   錯誤率：10%（每12題1錯）、20%（每12題2錯）、30%（每12題4錯）
//   總題數：36 題（每階段 12 題）
//   信心度：固定 90%
//   量表：每 12 題填一次，共 3 次，每次 4 題
//
// ── 2025 更新 ──────────────────────────────────────────────
//  [修改1] TW_10 的單一錯誤改為純 FP（人→AI），確保低錯誤率
//          雙向組仍能操弄「真人被誤判」的核心體驗
//  [修改2] 新增「階段性反饋」：每階段 12 題完成後，在填信任
//          量表之前顯示本階段 AI 系統的錯誤摘要，讓受試者能
//          明確感知單向 / 雙向錯誤的存在，確保操弄成立。
// ============================================================

// --- 1. Supabase 初始化 ---
const supabaseUrl  = 'https://gceaxslljccatxvvohtx.supabase.co';
const supabaseKey  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdjZWF4c2xsamNjYXR4dnZvaHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3OTI1ODAsImV4cCI6MjA4NjM2ODU4MH0.QJvdg8gYt_zX8HN7rfylt2UrgNhJ8HeldygRkaVhEX8';
const _supabase    = supabase.createClient(supabaseUrl, supabaseKey);

// --- 2. 六組實驗條件定義 ---
// [修改1] TW_10：direction='Two-way' 但 errorsPerStage=1，
//         buildTrials() 中針對 Two-way 且只有 1 個錯誤時，
//         改為放純 FP（真人→AI），而非 FN。
const EXPERIMENT_GROUPS = [
  { id: 'OW_10', direction: 'One-way', errorRate: 0.10, errorsPerStage: 1 },
  { id: 'OW_20', direction: 'One-way', errorRate: 0.20, errorsPerStage: 2 },
  { id: 'OW_30', direction: 'One-way', errorRate: 0.30, errorsPerStage: 4 },
  { id: 'TW_10', direction: 'Two-way', errorRate: 0.10, errorsPerStage: 1 },
  { id: 'TW_20', direction: 'Two-way', errorRate: 0.20, errorsPerStage: 2 },
  { id: 'TW_30', direction: 'Two-way', errorRate: 0.30, errorsPerStage: 4 },
];

// --- 3. 全域狀態 ---
let state = {
  userId:       localStorage.getItem('userId') || ('user_' + Math.random().toString(36).substr(2, 9)),
  groupConfig:  null,
  currentTrial: parseInt(localStorage.getItem('currentTrial')) || 0,
  trials:       [],
  startTime:    null,
  isProcessing: false,
  tempData:     null,
  surveyScores: [],
  demographics: null,
  // [修改2] 暫存當前階段的錯誤統計（供反饋畫面使用）
  stageErrorLog: { fn: 0, fp: 0, correct: 0 },
};

localStorage.setItem('userId', state.userId);

try {
  const demo = localStorage.getItem('demographics');
  if (demo) state.demographics = JSON.parse(demo);
} catch (e) {
  console.error('Failed to parse demographics:', e);
}

// --- 4. 分組邏輯（順序輪流分配，確保各組人數平衡）---
// 每位新受試者從 Supabase 拿一個遞增的 index，mod 6 決定組別。
// 使用 atomic DB 函數防止兩人同時拿到同一組。
// 若網路失敗則 fallback 到本地隨機，不阻斷實驗。
async function assignGroup() {
  const saved = localStorage.getItem('groupId');
  if (saved) {
    return EXPERIMENT_GROUPS.find(g => g.id === saved) || EXPERIMENT_GROUPS[0];
  }

  try {
    const { data, error } = await _supabase.rpc('get_and_increment_group_index');
    if (error) throw error;

    const idx   = data % EXPERIMENT_GROUPS.length;
    const group = EXPERIMENT_GROUPS[idx];
    localStorage.setItem('groupId', group.id);
    console.log(`✅ 順序分配 → index=${data}, 組別=${group.id}`);
    return group;

  } catch (err) {
    console.warn('⚠️ 順序分配失敗，改用隨機分配：', err.message);
    const idx   = Math.floor(Math.random() * EXPERIMENT_GROUPS.length);
    const group = EXPERIMENT_GROUPS[idx];
    localStorage.setItem('groupId', group.id);
    return group;
  }
}

// --- 5. 決定每道題的 AI 標籤（核心邏輯）---
// [修改1] Two-way + errorsPerStage=1 → 強制放 1 個 FP（人→AI）
function buildTrials(groupConfig) {
  const stage1 = STIMULI_POOL.filter(t => t.stage === 1);
  const stage2 = STIMULI_POOL.filter(t => t.stage === 2);
  const stage3 = STIMULI_POOL.filter(t => t.stage === 3);

  const shuffle = arr => arr.sort(() => Math.random() - 0.5);
  const s1 = shuffle([...stage1]);
  const s2 = shuffle([...stage2]);
  const s3 = shuffle([...stage3]);

  function applyCorrectLabel(trials) {
    return trials.map(t => ({ ...t, ai_label: t.actual, is_error_trial: false, error_type: null }));
  }

  function applyStage2Errors(trials, groupConfig) {
    const { direction, errorsPerStage } = groupConfig;
    const result = trials.map(t => ({ ...t, ai_label: t.actual, is_error_trial: false, error_type: null }));

    const fnCandidates = result.filter(t => t.actual === 'AI');
    const fpCandidates = result.filter(t => t.actual === 'Human');

    let fnCount, fpCount;

    if (direction === 'One-way') {
      // 單向：全部是 FN（AI→人）
      fnCount = errorsPerStage;
      fpCount = 0;
    } else {
      // 雙向：
      // [修改1] 若只有 1 個錯誤（TW_10），強制用 1 FP，確保受試者
      //         看到「真人被判為AI」這個最關鍵的雙向操弄。
      if (errorsPerStage === 1) {
        fnCount = 0;
        fpCount = 1;
      } else {
        // 2 個以上：平均分配，FP 稍多（讓雙向感更明顯）
        fpCount = Math.ceil(errorsPerStage / 2);
        fnCount = errorsPerStage - fpCount;
      }
    }

    const pickRandom = (arr, n) => shuffle([...arr]).slice(0, n);
    const fnErrors = pickRandom(fnCandidates, Math.min(fnCount, fnCandidates.length));
    const fpErrors = pickRandom(fpCandidates, Math.min(fpCount, fpCandidates.length));

    const fnIds = new Set(fnErrors.map(t => t.id));
    const fpIds = new Set(fpErrors.map(t => t.id));

    return result.map(t => {
      if (fnIds.has(t.id)) return { ...t, ai_label: 'Human', is_error_trial: true, error_type: 'false_negative' };
      if (fpIds.has(t.id)) return { ...t, ai_label: 'AI',    is_error_trial: true, error_type: 'false_positive' };
      return t;
    });
  }

  return [
    ...applyCorrectLabel(s1),
    ...applyStage2Errors(s2, groupConfig),
    ...applyCorrectLabel(s3),
  ];
}

// --- 6. UI 渲染 ---
function loadTrial() {
  const TOTAL = 36;
  if (state.currentTrial >= TOTAL) { showEndScreen(); return; }

  state.isProcessing = false;
  const trial = state.trials[state.currentTrial];

  document.getElementById('stimulus-content').innerHTML =
    `<div class="whitespace-pre-wrap text-gray-800 leading-relaxed text-base">${trial.content}</div>`;

  document.getElementById('ai-suggestion-box').classList.add('hidden');
  document.getElementById('action-buttons').classList.add('hidden');
  document.getElementById('custom-options').classList.add('hidden');

  const pct = (state.currentTrial / TOTAL) * 100;
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-text').innerText = `進度：${state.currentTrial + 1} / ${TOTAL}`;

  setTimeout(showAISuggestion, 1200);
}

function showAISuggestion() {
  const trial = state.trials[state.currentTrial];
  const box = document.getElementById('ai-suggestion-box');

  const CONFIDENCE = 85 + Math.floor(Math.random() * 10); // 85–94% 隨機浮動
  const isAI       = trial.ai_label === 'AI';
  const labelText  = isAI ? 'AI 生成' : '真人撰寫';
  const colorClass = isAI ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700';

  box.classList.remove('animate-pulse', 'hidden');
  box.innerHTML = `
    <div class="inline-flex items-center ${colorClass} px-4 py-2 rounded-full font-bold shadow-sm">
      <span class="mr-2">🛡️ 系統建議：[${labelText}]</span>
    </div>
    <p class="mt-2 text-xs text-gray-400">系統信心度：${CONFIDENCE}%</p>
  `;
  document.getElementById('action-buttons').classList.remove('hidden');
  state.startTime = Date.now();
}

// --- 7. 記錄回應 ---
async function recordResponse(agreedWithAI, customLabel = null) {
  if (state.isProcessing) return;
  state.isProcessing = true;

  const endTime = Date.now();
  const trial   = state.trials[state.currentTrial];

  let userFinalChoice;
  if (agreedWithAI) {
    userFinalChoice = trial.ai_label;
  } else {
    userFinalChoice = customLabel === 'ai' ? 'AI' : 'Human';
  }

  // [修改2] 累積本階段錯誤統計（每次答題後更新）
  if (trial.is_error_trial) {
    if (trial.error_type === 'false_negative') state.stageErrorLog.fn++;
    if (trial.error_type === 'false_positive') state.stageErrorLog.fp++;
  } else {
    state.stageErrorLog.correct++;
  }

  state.tempData = {
    user_id:         state.userId,
    group_id:        state.groupConfig.id,
    direction:       state.groupConfig.direction,
    error_rate:      state.groupConfig.errorRate,
    stage:           trial.stage,
    trial_number:    state.currentTrial + 1,
    stimulus_id:     trial.id,
    is_ai_generated: trial.actual === 'AI',
    ai_label:        trial.ai_label,
    is_error_trial:  trial.is_error_trial || false,
    error_type:      trial.error_type || null,
    user_choice:     userFinalChoice,
    agreed_with_ai:  agreedWithAI,
    is_correct:      userFinalChoice === trial.actual,
    response_time:   endTime - state.startTime,
    survey_data:     {},
    gender:          state.currentTrial === 0 && state.demographics ? state.demographics.gender       : null,
    age:             state.currentTrial === 0 && state.demographics ? state.demographics.age          : null,
    education:       state.currentTrial === 0 && state.demographics ? state.demographics.education    : null,
    occupation:      state.currentTrial === 0 && state.demographics ? state.demographics.occupation   : null,
    ai_experience:   state.currentTrial === 0 && state.demographics ? state.demographics.ai_experience: null,
  };

  // 每 12 題觸發流程：先顯示反饋，再填量表
  if ((state.currentTrial + 1) % 12 === 0) {
    // [修改2] 先顯示反饋畫面
    showStageFeedback();
  } else {
    await saveData();
  }
}

// ============================================================
// [修改2] 階段性反饋畫面
// 在填信任量表之前，告知受試者本階段 AI 的錯誤狀況。
// 這讓受試者能明確感知「單向」vs「雙向」錯誤的差異，
// 確保實驗操弄成功（manipulation check）。
// ============================================================
function showStageFeedback() {
  const phaseNumber = Math.ceil((state.currentTrial + 1) / 12); // 1, 2, or 3
  const log = state.stageErrorLog;
  const totalTrials = 12;

  // 組裝反饋內容（根據有無錯誤顯示不同資訊）
  let feedbackHTML = '';

  if (phaseNumber === 1 || phaseNumber === 3) {
    // 階段一和三：AI 完全正確，無錯誤（不顯示正確題數，避免受試者計算準確率）
    feedbackHTML = `
      <div class="flex items-center gap-2 text-gray-400 bg-gray-50 rounded-lg px-4 py-3 mb-2">
        <span class="text-xl">—</span>
        <span>AI 內容被誤判為真人：0 題</span>
      </div>
      <div class="flex items-center gap-2 text-gray-400 bg-gray-50 rounded-lg px-4 py-3">
        <span class="text-xl">—</span>
        <span>真人內容被誤判為 AI：0 題</span>
      </div>
    `;
  } else {
    // 階段二：顯示實際錯誤狀況
    const correctCount = log.correct;
    const fnCount = log.fn;  // AI 被誤判為真人（False Negative）
    const fpCount = log.fp;  // 真人被誤判為 AI（False Positive）

    const fnRow = fnCount > 0
      ? `<div class="flex items-center gap-2 text-orange-700 bg-orange-50 rounded-lg px-4 py-3 mb-2">
           <span class="text-xl">⚠️</span>
           <span class="font-medium">AI 內容被誤判為真人：${fnCount} 題</span>
         </div>`
      : `<div class="flex items-center gap-2 text-gray-400 bg-gray-50 rounded-lg px-4 py-3 mb-2">
           <span class="text-xl">—</span>
           <span>AI 內容被誤判為真人：0 題</span>
         </div>`;

    const fpRow = fpCount > 0
      ? `<div class="flex items-center gap-2 text-red-700 bg-red-50 rounded-lg px-4 py-3 mb-2">
           <span class="text-xl">🚨</span>
           <span class="font-medium">真人內容被誤判為 AI：${fpCount} 題</span>
         </div>`
      : `<div class="flex items-center gap-2 text-gray-400 bg-gray-50 rounded-lg px-4 py-3 mb-2">
           <span class="text-xl">—</span>
           <span>真人內容被誤判為 AI：0 題</span>
         </div>`;

    feedbackHTML = `
      ${fnRow}
      ${fpRow}
    `;
  }

  // 顯示反饋浮層
  const overlay = document.getElementById('survey-layer');
  const container = document.getElementById('survey-question-container');

  overlay.classList.remove('hidden');
  document.querySelector('#survey-layer h2').innerText = `第 ${phaseNumber} 階段結束`;
  document.querySelector('#survey-layer p.text-sm').innerText = '以下是本階段 AI 偵測系統的表現摘要，請參考後繼續完成問卷。';

  container.innerHTML = `
    <div class="mb-4">
      <p class="text-sm font-semibold text-gray-500 mb-3 uppercase tracking-wide">AI 系統本階段表現</p>
      ${feedbackHTML}
    </div>
    <button
      onclick="startSurveyAfterFeedback()"
      class="w-full mt-4 bg-indigo-600 text-white py-3 rounded-lg hover:bg-indigo-700 transition font-medium">
      我已了解，繼續填寫問卷 →
    </button>
  `;
}

// 受試者確認反饋後，進入信任量表
function startSurveyAfterFeedback() {
  // 重置下一階段的錯誤計數器
  state.stageErrorLog = { fn: 0, fp: 0, correct: 0 };
  // 進入量表
  startSurveyQuestions();
}

// --- 8. 信任量表（含感知公平性）---
//
// Phase 1 & 3：4 題核心信任量表（Jian et al., 2000 改編）
// Phase 2：  4 題信任 + 2 題感知公平性（共 6 題）
//   Q5：感知公平性（系統判斷是否公平）
//   Q6：冤枉威脅感（最核心的理論機制，雙向組應顯著更高）
//
// 資料儲存在 survey_data JSONB 欄位：
//   Phase 1/3：{ trust_q1~q4, trust_avg, phase }
//   Phase 2：  { trust_q1~q4, trust_avg, fairness_q5, threat_q6,
//               fairness_avg, phase }

function showSurvey() {
  startSurveyQuestions();
}

function startSurveyQuestions() {
  const overlay = document.getElementById('survey-layer');
  overlay.classList.remove('hidden');
  state.surveyScores = [];

  document.querySelector('#survey-layer h2').innerText = '階段結束，請完成簡短問卷';
  document.querySelector('#survey-layer p.text-sm').innerText = '請根據您剛才的體驗，誠實評估以下各項敘述。';

  renderSurveyQuestion(0);
}

// 四題核心信任量表（所有階段都問）
const TRUST_QUESTIONS = [
  '這個 AI 系統是可信賴的。',
  '這個 AI 系統的行為是可預測的。',
  '我對這個 AI 系統提供的判斷有信心。',
  '我願意依據這個系統的建議做出決定。',
];

// 兩題感知公平性（只在 Phase 2 加問）
const FAIRNESS_QUESTIONS = [
  '我覺得這個系統對所有內容的判斷方式是公平的。',
  '我擔心這個系統可能會將真人撰寫的內容誤判為 AI 生成。',
];

function getCurrentQuestions() {
  const phase = Math.ceil((state.currentTrial + 1) / 12);
  if (phase === 2) {
    return [...TRUST_QUESTIONS, ...FAIRNESS_QUESTIONS]; // 6 題
  }
  return TRUST_QUESTIONS; // 4 題
}

function renderSurveyQuestion(index) {
  const questions = getCurrentQuestions();
  const total     = questions.length;
  const container = document.getElementById('survey-question-container');

  // Phase 2 第 5、6 題加上提示標籤
  const phase       = Math.ceil((state.currentTrial + 1) / 12);
  const isFairness  = phase === 2 && index >= 4;
  const sectionTag  = isFairness
    ? `<span class="inline-block text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full mb-2 font-medium">關於系統公平性</span><br>`
    : '';

  container.innerHTML = `
    <p class="text-sm text-gray-500 mb-1">題目 ${index + 1} / ${total}</p>
    ${sectionTag}
    <p class="text-base font-medium text-gray-800 mb-4">${questions[index]}</p>
    <div class="flex justify-between text-xs text-gray-400 mb-1">
      <span>1 完全不同意</span><span>7 完全同意</span>
    </div>
    <div class="flex gap-2 justify-center mb-6">
      ${[1,2,3,4,5,6,7].map(v => `
        <button onclick="selectSurveyAnswer(${index}, ${v})"
          id="sq-${v}"
          class="w-10 h-10 rounded-full border-2 border-gray-300 text-sm font-bold
                 hover:bg-indigo-100 hover:border-indigo-400 transition">
          ${v}
        </button>`).join('')}
    </div>
  `;
}

function selectSurveyAnswer(index, value) {
  const questions = getCurrentQuestions();

  [1,2,3,4,5,6,7].forEach(v => {
    const btn = document.getElementById(`sq-${v}`);
    if (btn) btn.classList.remove('bg-indigo-500', 'text-white', 'border-indigo-500');
  });
  const chosen = document.getElementById(`sq-${value}`);
  if (chosen) chosen.classList.add('bg-indigo-500', 'text-white', 'border-indigo-500');

  setTimeout(() => {
    state.surveyScores[index] = value;
    if (index + 1 < questions.length) {
      renderSurveyQuestion(index + 1);
    } else {
      submitSurvey();
    }
  }, 350);
}

async function submitSurvey() {
  const scores  = state.surveyScores;
  const phase   = Math.ceil((state.currentTrial + 1) / 12);

  // 信任分數（前四題，所有階段都有）
  const trustScores = scores.slice(0, 4);
  const trustAvg    = trustScores.reduce((a, b) => a + b, 0) / trustScores.length;

  const surveyData = {
    trust_q1:  trustScores[0],
    trust_q2:  trustScores[1],
    trust_q3:  trustScores[2],
    trust_q4:  trustScores[3],
    trust_avg: parseFloat(trustAvg.toFixed(3)),
    phase,
  };

  // Phase 2 額外儲存感知公平性兩題
  if (phase === 2 && scores.length === 6) {
    const fairnessAvg = (scores[4] + scores[5]) / 2;
    surveyData.fairness_q5  = scores[4]; // 公平性感知
    surveyData.threat_q6    = scores[5]; // 冤枉威脅感（越高代表越擔心被誤判）
    surveyData.fairness_avg = parseFloat(fairnessAvg.toFixed(3));
  }

  state.tempData.survey_data = surveyData;

  document.getElementById('survey-layer').classList.add('hidden');
  await saveData();
}

// --- 9. 儲存資料 ---
async function saveData() {
  const { error } = await _supabase.from('experiment_results_v2').insert([state.tempData]);
  if (error) console.error('儲存失敗：', error);

  state.currentTrial++;
  localStorage.setItem('currentTrial', state.currentTrial);
  loadTrial();
}

// --- 10. 結束畫面 ---
function showEndScreen() {
  const container = document.getElementById('experiment-page') || document.getElementById('main-container');
  container.innerHTML = `
    <div class="text-center py-10">
      <h2 class="text-2xl font-bold text-green-600">🎉 實驗已完成，謝謝您的參與！</h2>
      <p class="mt-4 text-gray-600">
        您的回答對於 AI 信任研究非常有價值。<br>
        現在您可以關閉此頁面。
      </p>
      <div class="mt-6 p-4 bg-gray-50 rounded-lg text-sm text-gray-500">
        <p class="font-medium mb-1">📋 事後說明</p>
        <p>本實驗目的是研究人們對 AI 偵測系統的信任行為。<br>
        實驗中 AI 系統所顯示的部分標籤為刻意設計的錯誤，用以觀察信任變化，並非系統真實表現。感謝您的理解與配合。</p>
      </div>
      <button onclick="resetExperiment()" class="mt-8 text-sm text-blue-500 underline">重新開始（開發測試用）</button>
    </div>
  `;
}

function resetExperiment() {
  localStorage.clear();
  location.reload();
}

// --- 11. 自行判斷按鈕 ---
function showCustomOptions() {
  document.getElementById('custom-options').classList.remove('hidden');
}

// --- 12. 實驗開始函數 ---
async function startExperiment() {
  if (!state.demographics) {
    console.error('Error: Demographics data not found.');
    document.getElementById('experiment-page').classList.add('hidden');
    document.getElementById('demographics-page').classList.remove('hidden');
    document.getElementById('progress-section').classList.add('hidden');
    return;
  }

  // 顯示等待提示（assignGroup 需要連線 Supabase）
  document.getElementById('group-display').innerText = '受試代號：分配中...';

  state.groupConfig = await assignGroup();
  state.trials      = buildTrials(state.groupConfig);

  // 初始化階段錯誤計數器
  state.stageErrorLog = { fn: 0, fp: 0, correct: 0 };

  document.getElementById('group-display').innerText =
    `受試代號：${state.userId.toUpperCase()}`;

  loadTrial();
}

// --- 13. 頁面載入 ---
window.onload = () => {
  const hasDemographics = localStorage.getItem('demographics');

  if (hasDemographics) {
    document.getElementById('demographics-page').classList.add('hidden');
    document.getElementById('experiment-page').classList.remove('hidden');
    document.getElementById('progress-section').classList.remove('hidden');
    startExperiment();
  }
};



