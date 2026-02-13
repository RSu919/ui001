// --- 1. 初始化與設定 ---
const supabaseUrl = 'https://gceaxslljccatxvvohtx.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdjZWF4c2xsamNjYXR4dnZvaHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3OTI1ODAsImV4cCI6MjA4NjM2ODU4MH0.QJvdg8gYt_zX8HN7rfylt2UrgNhJ8HeldygRkaVhEX8';
const _supabase = supabase.createClient(supabaseUrl, supabaseKey);

let state = {
    userId: localStorage.getItem('userId') || 'user_' + Math.random().toString(36).substr(2, 9),
    group: localStorage.getItem('group') || (Math.random() > 0.5 ? 'One-way' : 'Two-way'),
    currentTrial: parseInt(localStorage.getItem('currentTrial')) || 0,
    trials: [], 
    startTime: null,
    clickCount: 0,
    isProcessing: false, // 防止重複點擊
    tempData: null       // 暫存第 20, 40, 60 題的數據以待問卷填完一起存
};

localStorage.setItem('userId', state.userId);
localStorage.setItem('group', state.group);

// --- 2. 實驗演算法 ---
function generateTrials() {
    if (typeof STIMULI_POOL === 'undefined') return [];
    let allTrials = [...STIMULI_POOL];
    let stage1 = allTrials.filter(t => t.stage === 1).sort(() => 0.5 - Math.random());
    let stage2 = allTrials.filter(t => t.stage === 2).sort(() => 0.5 - Math.random());
    let stage3 = allTrials.filter(t => t.stage === 3).sort(() => 0.5 - Math.random());
    return [...stage1, ...stage2, ...stage3];
}

// --- 3. UI 渲染邏輯 ---
function loadTrial() {
    if (state.currentTrial >= 60) {
        showEndScreen();
        return;
    }

    state.isProcessing = false; // 重置狀態
    const trial = state.trials[state.currentTrial];
    document.getElementById('stimulus-content').innerHTML = `<div class="whitespace-pre-wrap text-gray-800 leading-relaxed text-base">${trial.content}</div>`;
    
    document.getElementById('ai-suggestion-box').classList.add('hidden');
    document.getElementById('action-buttons').classList.add('hidden');
    document.getElementById('custom-options').classList.add('hidden');
    
    const progress = (state.currentTrial / 60) * 100;
    document.getElementById('progress-bar').style.width = `${progress}%`;
    document.getElementById('progress-text').innerText = `進度: ${state.currentTrial + 1} / 60`;

    setTimeout(showAISuggestion, 1200);
}

function showAISuggestion() {
    const trial = state.trials[state.currentTrial];
    const box = document.getElementById('ai-suggestion-box');
    const confidence = Math.floor(Math.random() * (96 - 88 + 1) + 88);
    let aiLabelRaw = (state.group === 'One-way') ? trial.ai_label_oneway : trial.ai_label_twoway;
    const labelDisplay = (aiLabelRaw === 'AI') ? 'AI 生成' : '真人撰寫';
    const colorClass = (aiLabelRaw === 'AI') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700';
    
    box.classList.remove('animate-pulse', 'hidden');
    box.innerHTML = `
        <div class="inline-flex items-center ${colorClass} px-4 py-2 rounded-full font-bold shadow-sm">
            <span class="mr-2">🛡️ 系統建議：[${labelDisplay}]</span>
        </div>
        <p class="mt-2 text-xs text-gray-400">系統信心度：${confidence}%</p>
    `;
    document.getElementById('action-buttons').classList.remove('hidden');
    state.startTime = Date.now();
    state.clickCount = 0;
}

// --- 4. 數據紀錄 ---
async function recordResponse(agreedWithAI, customLabel = null) {
    if (state.isProcessing) return; // 防止連點
    state.isProcessing = true;

    const endTime = Date.now();
    const trial = state.trials[state.currentTrial];
    let userFinalChoice = agreedWithAI 
        ? ((state.group === 'One-way') ? trial.ai_label_oneway : trial.ai_label_twoway)
        : (customLabel === 'ai' ? 'AI' : 'Human');

    // 準備要存入資料庫的物件
    state.tempData = {
        user_id: state.userId,
        group: state.group,
        stage: trial.stage,
        trial_number: state.currentTrial + 1,
        stimulus_id: trial.id,
        is_ai_generated: trial.actual === 'AI',
        ai_suggestion: (state.group === 'One-way') ? trial.ai_label_oneway : trial.ai_label_twoway,
        user_choice: userFinalChoice,
        is_correct: userFinalChoice === trial.actual,
        response_time: endTime - state.startTime,
        click_count: state.clickCount,
        survey_data: {} // 預設空
    };

    // 每 20 題觸發問卷，否則直接儲存
    if ((state.currentTrial + 1) % 20 === 0) {
        document.getElementById('survey-layer').classList.remove('hidden');
    } else {
        await saveData();
    }
}

async function saveData() {
    const { error } = await _supabase.from('experiment_results').insert([state.tempData]);
    if (error) console.error('儲存失敗:', error);

    state.currentTrial++;
    localStorage.setItem('currentTrial', state.currentTrial);
    loadTrial();
}

// 處理問卷送出
document.getElementById('survey-form').onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const trustScore = formData.get('trust_score');
    
    // 將問卷分數併入暫存數據
    state.tempData.survey_data = { trust_score: trustScore };
    
    document.getElementById('survey-layer').classList.add('hidden');
    e.target.reset();
    
    // 儲存帶有問卷結果的這筆資料
    await saveData();
};

function showEndScreen() {
    document.getElementById('experiment-container').innerHTML = `
        <div class="text-center py-10">
            <h2 class="text-2xl font-bold text-green-600">🎉 實驗已完成</h2>
            <p class="mt-4 text-gray-600">您的貢獻對 AI 信任研究非常有價值。現在您可以關閉視窗。</p>
            <button onclick="location.reload()" class="mt-8 text-sm text-blue-500 underline">重新開始測試 (僅供開發使用)</button>
        </div>
    `;
    localStorage.clear(); // 結束後清空進度，方便下次測試
}

function showCustomOptions() {
    state.clickCount++;
    document.getElementById('custom-options').classList.remove('hidden');
}

window.onload = () => {
    state.trials = generateTrials();
    if (state.trials.length > 0) {
        document.getElementById('group-display').innerText = `受試代號：${state.userId.toUpperCase()}`;
        loadTrial();
    }
};