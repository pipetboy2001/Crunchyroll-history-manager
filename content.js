// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const CONFIG = {
    CHECK_INTERVAL_MS: 1000,
    API_PAGE_SIZE: 1000,
    DELETE_CHUNK_SIZE: 150,
    API_BASE_URL: "https://www.crunchyroll.com/content/v2",
    AUTH_URL: "https://www.crunchyroll.com/auth/v1/token",
    PUBLIC_CLIENT_AUTH: "Basic bm9haWhkZXZtXzZpeWcwYThsMHE6", // Public web client auth
    UI_CONTAINER_ID: "crunchy-cleaner-ui"
};

const UI_TEXT = {
    PANEL_TITLE: "🧹 History Cleaner",
    PANEL_DESC: "Select the exact anime to delete:",
    LOADING_DB: "⏳ Loading database...",
    SELECT_DEFAULT: "-- Choose an anime to delete --",
    BTN_WAITING: "Waiting for data...",
    BTN_READY: "Delete Series",
    BTN_PROCESSING: "Processing...",
    CONFIRM_DELETE: (title) => `Are you sure you want to delete ALL episodes of "${title}" from your account? This cannot be undone.`,
    ERR_NO_SELECTION: "Please select an anime from the list.",
    ERR_NO_EPISODES: (title) => `Error: No episodes found for "${title}".`,
    STEP_CONNECTING: "1/3: Connecting to Crunchyroll...",
    STEP_SEARCHING: (title) => `2/3: Searching episodes of "${title}"...`,
    STEP_DELETING: (count) => `3/3: Destroying ${count} episodes...`,
    SUCCESS: "Success! Reloading the page..."
};

// ==========================================
// STATE MANAGEMENT
// ==========================================
let isHistoryLoaded = false;

// ==========================================
// MAIN INITIALIZATION
// ==========================================
setInterval(monitorPageStatus, CONFIG.CHECK_INTERVAL_MS);

function monitorPageStatus() {
    const isHistoryPage = window.location.href.includes('history') || window.location.href.includes('historial');
    const existingUI = document.getElementById(CONFIG.UI_CONTAINER_ID);

    if (!isHistoryPage) {
        if (existingUI) existingUI.style.display = 'none';
        return;
    }

    if (!existingUI) {
        buildUI();
        loadDatabaseSilently();
    } else {
        existingUI.style.display = 'block';
    }
}

// ==========================================
// UI MANAGER
// ==========================================
function buildUI() {
    const container = document.createElement('div');
    container.id = CONFIG.UI_CONTAINER_ID;
        container.innerHTML = `
        <h3 class="cleaner-title">${UI_TEXT.PANEL_TITLE}</h3>
        <p class="cleaner-desc">${UI_TEXT.PANEL_DESC}</p>
        
        <select id="cleaner-select" class="cleaner-select" disabled>
            <option value="">${UI_TEXT.LOADING_DB}</option>
        </select>

        <button id="cleaner-btn" class="cleaner-btn" disabled>
            ${UI_TEXT.BTN_WAITING}
        </button>
        
        <p id="cleaner-status"></p>
    `;

    document.body.appendChild(container);
    attachUIListeners();
}

function attachUIListeners() {
    const btn = document.getElementById('cleaner-btn');
    
    btn.addEventListener('click', async () => {
        const select = document.getElementById('cleaner-select');
        const status = document.getElementById('cleaner-status');
        const selectedTitle = select.value;

        if (!selectedTitle) {
            alert(UI_TEXT.ERR_NO_SELECTION);
            return;
        }

        if (confirm(UI_TEXT.CONFIRM_DELETE(selectedTitle))) {
            setUIProcessingState(true, btn, select, status);
            await executeDeepClean(selectedTitle, status, btn, select);
        }
    });
}

function setUIProcessingState(isProcessing, btn, select, status) {
    btn.disabled = isProcessing;
    select.disabled = isProcessing;
    status.style.display = isProcessing ? "block" : "none";
        if (isProcessing) {
        btn.classList.remove('ready');
        btn.innerText = UI_TEXT.BTN_PROCESSING;
    } else {
        btn.classList.add('ready');
        btn.innerText = UI_TEXT.BTN_READY;
    }
}

function populateSelectMenu(uniqueSeries) {
    const select = document.getElementById('cleaner-select');
    const btn = document.getElementById('cleaner-btn');
    if (!select || !btn) return;

    let optionsHTML = `<option value="">${UI_TEXT.SELECT_DEFAULT}</option>`;
    
    Array.from(uniqueSeries).sort().forEach(series => {
        optionsHTML += `<option value="${series}">${series}</option>`;
    });

    select.innerHTML = optionsHTML;
    select.disabled = false;
    
    btn.disabled = false;
    btn.classList.add('ready');
    btn.innerText = UI_TEXT.BTN_READY;
}

// ==========================================
// CORE BUSINESS LOGIC & API CALLS
// ==========================================
async function loadDatabaseSilently() {
    if (isHistoryLoaded) return;
    
    try {
        const tokenData = await fetchAuthToken();
        if (!tokenData) throw new Error("Authentication failed.");

        const firstPageData = await fetchHistoryPage(tokenData, 1);
        const totalPages = Math.ceil(firstPageData.total / CONFIG.API_PAGE_SIZE);
        let uniqueSeries = new Set();

        const extractSeriesTitles = (items) => {
            items.forEach(item => {
                if (item?.panel?.episode_metadata?.series_title) {
                    uniqueSeries.add(item.panel.episode_metadata.series_title);
                }
            });
        };

        extractSeriesTitles(firstPageData.data);
        const fetchPromises = [];
        for (let i = 2; i <= totalPages; i++) {
            const req = fetchHistoryPage(tokenData, i).then(pageData => extractSeriesTitles(pageData.data));
            fetchPromises.push(req);
        }
        await Promise.all(fetchPromises);

        populateSelectMenu(uniqueSeries);
        isHistoryLoaded = true;

    } catch (error) {
        console.error("[Crunchyroll Cleaner] Error loading history:", error);
        const select = document.getElementById('cleaner-select');
        if (select) select.innerHTML = `<option value="">Error loading DB. Press F5.</option>`;
    }
}

async function executeDeepClean(title, statusText, btn, select) {
    try {
        statusText.innerText = UI_TEXT.STEP_CONNECTING;
        const tokenData = await fetchAuthToken();
        
        statusText.innerText = UI_TEXT.STEP_SEARCHING(title);
        const targetIds = await getEpisodeIdsByTitle(title, tokenData);
        
        if (targetIds.length === 0) {
            alert(UI_TEXT.ERR_NO_EPISODES(title));
            setUIProcessingState(false, btn, select, statusText);
            return;
        }

        statusText.innerText = UI_TEXT.STEP_DELETING(targetIds.length);
        await bulkDeleteEpisodes(targetIds, tokenData);

        statusText.innerText = UI_TEXT.SUCCESS;
        setTimeout(() => location.reload(), 1500);

    } catch (error) {
        alert(`An error occurred: ${error.message}`);
        setUIProcessingState(false, btn, select, statusText);
    }
}

// ==========================================
// API WRAPPERS
// ==========================================
async function fetchAuthToken() {
    const response = await fetch(CONFIG.AUTH_URL, {
        method: "POST",
        headers: {
            "Authorization": CONFIG.PUBLIC_CLIENT_AUTH,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `device_id=${crypto.randomUUID()}&device_type=Chrome&grant_type=etp_rt_cookie`,
        credentials: "include" 
    });
    
    if (!response.ok) return null;
    return await response.json();
}

async function fetchHistoryPage(tokenData, pageNumber) {
    const url = `${CONFIG.API_BASE_URL}/${tokenData.account_id}/watch-history?page_size=${CONFIG.API_PAGE_SIZE}&page=${pageNumber}`;
    const response = await fetch(url, { 
        headers: { "Authorization": `Bearer ${tokenData.access_token}` } 
    });
    return await response.json();
}

async function getEpisodeIdsByTitle(targetTitle, tokenData) {
    const firstPageData = await fetchHistoryPage(tokenData, 1);
    const totalPages = Math.ceil(firstPageData.total / CONFIG.API_PAGE_SIZE);
    let episodeIds = [];

    const filterTargetIds = (items) => {
        return items
            .filter(item => item?.panel?.episode_metadata?.series_title === targetTitle)
            .map(item => item.id);
    };

    episodeIds.push(...filterTargetIds(firstPageData.data));

    const fetchPromises = [];
    for (let i = 2; i <= totalPages; i++) {
        const req = fetchHistoryPage(tokenData, i).then(pageData => {
            episodeIds.push(...filterTargetIds(pageData.data));
        });
        fetchPromises.push(req);
    }
    
    await Promise.all(fetchPromises);
    return episodeIds;
}

async function bulkDeleteEpisodes(idsArray, tokenData) {
    for (let i = 0; i < idsArray.length; i += CONFIG.DELETE_CHUNK_SIZE) {
        const chunk = idsArray.slice(i, i + CONFIG.DELETE_CHUNK_SIZE).join(",");
        const url = `${CONFIG.API_BASE_URL}/${tokenData.account_id}/watch-history/${chunk}`;
        
        await fetch(url, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${tokenData.access_token}`,
                "Content-Type": "application/json"
            }
        });
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}