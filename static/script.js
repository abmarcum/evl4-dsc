let currentPartition = 1;
const zonesGrid = document.getElementById('zones-grid');
const numZones = 64; 
let ws;
let reconnectInterval;

const flagsGrid = document.getElementById('flags-grid');
const flagsToTrack = [
    { key: 'ready', label: 'Ready' },
    { key: 'armed_stay', label: 'Armed Stay' },
    { key: 'armed_away', label: 'Armed Away' },
    { key: 'trouble', label: 'Trouble' },
    { key: 'bypass', label: 'Bypass' },
    { key: 'chime', label: 'Chime' },
    { key: 'alarm', label: 'Alarm' },
    { key: 'entry_delay', label: 'Entry Delay' },
    { key: 'exit_delay', label: 'Exit Delay' },
    { key: 'ac_present', label: 'AC Power' },
];

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        clearInterval(reconnectInterval);
        document.getElementById('conn-dot').className = 'dot connected';
        document.getElementById('conn-text').textContent = 'Live';
    };

    ws.onmessage = (event) => {
        if (event.data === 'pong') return;
        try {
            const data = JSON.parse(event.data);
            handleStateUpdate(data);
        } catch (e) {
            console.error("Parse error:", e);
        }
    };

    ws.onclose = () => {
        document.getElementById('conn-dot').className = 'dot disconnected';
        document.getElementById('conn-text').textContent = 'Reconnecting...';
        reconnectInterval = setTimeout(connectWebSocket, 3000);
    };
    
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 15000);
}

function handleStateUpdate(data) {
    if (!data.connected) {
        document.getElementById('panel-state-text').textContent = 'Connecting...';
        document.getElementById('panel-state-text').className = 'state-text';
        document.getElementById('panel-sub-state').textContent = 'Waiting for panel connection.';
        return;
    }
    
    updatePartitionsDropdown(data.partitions);
    if (data.partitions[currentPartition]) {
        updatePanelState(data.partitions[currentPartition], data.zones);
    }
    updateZones(data.zones, data.zone_names);
    updateActivityFeed(data.events);
}

function updatePartitionsDropdown(partitionsObj) {
    const selector = document.getElementById('partition-selector');
    const existingPartitions = Array.from(selector.options).map(o => parseInt(o.value));
    
    Object.keys(partitionsObj).forEach(pNum => {
        pNum = parseInt(pNum);
        if (!existingPartitions.includes(pNum)) {
            const opt = document.createElement('option');
            opt.value = pNum;
            opt.textContent = `Partition ${pNum}`;
            selector.appendChild(opt);
        }
    });
}

function changePartition() {
    currentPartition = parseInt(document.getElementById('partition-selector').value);
}

function formatTime(seconds) {
    if (seconds < 0) return '';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds/60)}m`;
    return `${Math.floor(seconds/3600)}h ${Math.floor((seconds%3600)/60)}m`;
}

function updatePanelState(partition, zones) {
    const stateEl = document.getElementById('panel-state-text');
    const subEl = document.getElementById('panel-sub-state');
    const debugAlert = document.getElementById('debug-alert');
    const debugText = document.getElementById('debug-alert-text');
    
    stateEl.className = 'state-text'; 
    debugAlert.classList.add('hidden');
    
    if (partition.alarm) {
        stateEl.textContent = 'ALARM';
        stateEl.classList.add('text-alarm');
        subEl.textContent = 'System is in alarm state!';
    } else if (partition.armed_away) {
        stateEl.textContent = 'ARMED AWAY';
        stateEl.classList.add('text-armed');
        subEl.textContent = 'System is armed (Away)';
    } else if (partition.armed_stay) {
        stateEl.textContent = 'ARMED STAY';
        stateEl.classList.add('text-armed');
        subEl.textContent = 'System is armed (Stay)';
    } else if (partition.exit_delay) {
        stateEl.textContent = 'EXIT DELAY';
        stateEl.classList.add('text-not-ready');
        subEl.textContent = 'Please exit the premises';
    } else if (partition.entry_delay) {
        stateEl.textContent = 'ENTRY DELAY';
        stateEl.classList.add('text-not-ready');
        subEl.textContent = 'Please disarm system';
    } else if (!partition.ready) {
        stateEl.textContent = 'NOT READY';
        stateEl.classList.add('text-not-ready');
        subEl.textContent = 'Zones are open or in trouble';
        
        let openZoneNames = [];
        Object.keys(zones).forEach(z => {
            if ((zones[z].open || zones[z].fault) && !zones[z].bypassed) {
                openZoneNames.push(`${zones[z].name} (${z})`);
            }
        });
        if (openZoneNames.length > 0) {
            debugText.textContent = openZoneNames.join(", ") + " must be closed.";
            debugAlert.classList.remove('hidden');
        }
        
    } else if (partition.ready) {
        stateEl.textContent = 'READY';
        stateEl.classList.add('text-ready');
        subEl.textContent = 'System is ready to arm';
    } else {
        stateEl.textContent = 'UNKNOWN';
        subEl.textContent = partition.partition_state || 'Waiting for data...';
    }
    
    flagsGrid.innerHTML = '';
    flagsToTrack.forEach(f => {
        if (partition[f.key]) {
            const flagEl = document.createElement('div');
            flagEl.className = f.key === 'trouble' ? 'flag active-warn' : 'flag active';
            flagEl.textContent = f.label;
            flagsGrid.appendChild(flagEl);
        }
    });
}

function updateZones(zones, zoneNames) {
    let maxZoneSeen = 8;
    if (discoveryMode) {
        maxZoneSeen = 64;
    } else {
        Object.keys(zones).forEach(k => {
            if (zones[k].open || zones[k].fault || zones[k].bypassed || zones[k].alarm || zoneNames[k]) {
                if (parseInt(k) > maxZoneSeen) maxZoneSeen = parseInt(k);
            }
        });
        maxZoneSeen = Math.ceil(maxZoneSeen / 8) * 8;
    }

    zonesGrid.innerHTML = '';
    for (let i = 1; i <= maxZoneSeen; i++) {
        const zone = zones[i] || {open: false, alarm: false, bypassed: false, name: `Zone ${i}`, timer: -1};
        const el = document.createElement('div');
        el.className = 'zone-card';
        el.onclick = () => sendBypass(i);
        
        let statusStr = "Closed";
        if (zone.alarm) { el.classList.add('alarm'); statusStr = "Alarm"; }
        else if (zone.open || zone.fault) { el.classList.add('open'); statusStr = "Open"; }
        else if (zone.bypassed) { el.classList.add('bypassed'); statusStr = "Bypassed"; }

        let timerStr = "";
        if (zone.timer >= 0) {
            timerStr = `<div class="z-time">${statusStr === 'Closed' ? 'Closed' : 'Opened'} ${formatTime(zone.timer)} ago</div>`;
        }

        let isUnknown = !zoneNames[i];
        let unknownBadge = (discoveryMode && isUnknown) ? `<div style="font-size:0.65rem; color:var(--brand-purple); text-transform:uppercase; font-weight:700;">Unknown</div>` : ``;
        
        let icon = "";
        if (zone.type === "opening") icon = "🚪 ";
        else if (zone.type === "motion") icon = "🏃‍♂️ ";
        else if (zone.type === "glass") icon = "🪟 ";
        else if (zone.type === "smoke") icon = "🔥 ";

        el.innerHTML = `
            <div class="z-header">
                <span class="z-num">Z${i}</span>
                <div class="z-status-dot"></div>
            </div>
            <div class="z-name">${icon}${zone.name}</div>
            ${unknownBadge}
            ${timerStr}
        `;
        
        // Highlight active unknown zones during debug
        if (discoveryMode && isUnknown && (zone.open || zone.fault)) {
            el.style.borderColor = 'var(--brand-purple)';
            el.style.boxShadow = '0 0 15px rgba(139, 92, 246, 0.4)';
        }
        
        zonesGrid.appendChild(el);
    }
}

function updateActivityFeed(events) {
    const feed = document.getElementById('activity-feed');
    feed.innerHTML = '';
    events.forEach(ev => {
        const item = document.createElement('div');
        item.className = 'activity-item';
        item.innerHTML = `
            <div class="activity-time">${ev.time}</div>
            <div class="activity-msg">${ev.message}</div>
        `;
        feed.appendChild(item);
    });
}

async function apiPost(payload) {
    payload.partition = currentPartition;
    try {
        const response = await fetch('/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const err = await response.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (error) {
        console.error("Error sending command:", error);
    }
}

function sendCommand(action) {
    let code = null;
    if (action === 'disarm') {
        code = prompt("Enter PIN code to disarm:");
        if (!code) return; 
    }
    apiPost({ action: action, code: code });
}

function sendBypass(zoneId) {
    if(confirm(`Toggle bypass for Zone ${zoneId}?`)) {
        apiPost({ action: 'bypass', zone: zoneId });
    }
}

function sendPanic(type) {
    if(confirm(`WARNING! Activate ${type} Panic Alarm?`)) {
        apiPost({ action: 'panic', panic_type: type });
    }
}

function sendOutput(num) {
    apiPost({ action: 'output', output_num: num });
}

const keypadInput = document.getElementById('keypad-input');
function addKey(k) { keypadInput.value += k; }
function clearKeypad() { keypadInput.value = ''; }
function sendKeypadSequence() {
    const keys = keypadInput.value;
    if (keys) {
        apiPost({ action: 'keypress', keys: keys });
        clearKeypad();
    }
}

let discoveryMode = false;
function toggleDiscoveryMode() {
    discoveryMode = !discoveryMode;
    const btn = document.getElementById('btn-discovery');
    if(discoveryMode) {
        btn.classList.add('active-debug');
        btn.textContent = 'Hide Unknown';
    } else {
        btn.classList.remove('active-debug');
        btn.textContent = 'Debug Unknown';
    }
    // Refresh UI with latest data
    fetch('/api/status').then(r=>r.json()).then(data => handleStateUpdate(data));
}

function syncTime() {
    let code = prompt("Enter Master Code to sync time:");
    if (code) apiPost({ action: 'sync_time', code: code });
}

function debugTroubles() {
    apiPost({ action: 'keypress', keys: '*2' });
}

function setAccessCode() {
    const master = document.getElementById('master-code').value;
    const slot = document.getElementById('user-slot').value;
    const newPin = document.getElementById('new-pin').value;
    
    if (!master || !slot || !newPin) {
        alert("All fields are required to set a code.");
        return;
    }
    
    apiPost({
        action: 'set_code',
        code: master,
        user_slot: slot,
        new_pin: newPin
    });
    
    document.getElementById('master-code').value = '';
    document.getElementById('user-slot').value = '';
    document.getElementById('new-pin').value = '';
    alert("Code update command sent!");
}

connectWebSocket();
