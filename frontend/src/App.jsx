import { useEffect, useState, useRef, useMemo } from 'react';

const formatTime = (seconds) => {
    if (seconds < 0) return '';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds/60)}m`;
    return `${Math.floor(seconds/3600)}h ${Math.floor((seconds%3600)/60)}m`;
};

// Web Audio API for Keypad Beeps
const playBeep = (theme = 'default') => {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        // DSKY Theme sounds more mechanical/digital, Default is a standard soft keypad beep
        osc.type = theme === 'dsky' ? 'square' : 'sine';
        osc.frequency.setValueAtTime(theme === 'dsky' ? 950 : 800, ctx.currentTime);
        gain.gain.setValueAtTime(theme === 'dsky' ? 0.05 : 0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
    } catch (e) { console.error("Audio error:", e); }
};

function App() {
  const [data, setData] = useState({ connected: false, partitions: {}, zones: {}, events: [], zone_names: {} });
  const [currentPartition, setCurrentPartition] = useState(1);
  const [discoveryMode, setDiscoveryMode] = useState(false);
  const [keypadInput, setKeypadInput] = useState('');
  const [wsStatus, setWsStatus] = useState('Connecting');
  const [theme, setTheme] = useState('modern');
  
  const [adminForm, setAdminForm] = useState({ master: '', slot: '', newPin: '' });
  const wsRef = useRef(null);

  useEffect(() => {
      document.body.className = theme === 'dsky' ? 'theme-dsky' : '';
  }, [theme]);
  
  useEffect(() => {
    const connectWS = () => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // In dev mode (Vite), window.location.host is localhost:5173 but proxy sends /ws to 8000
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        
        ws.onopen = () => setWsStatus('Live');
        ws.onmessage = (event) => {
            if (event.data === 'pong') return;
            try {
                setData(JSON.parse(event.data));
            } catch (e) {
                console.error("Parse error:", e);
            }
        };
        ws.onclose = () => {
            setWsStatus('Reconnecting...');
            setTimeout(connectWS, 3000);
        };
    };
    
    connectWS();
    
    const pingInterval = setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send("ping");
    }, 15000);
    
    return () => {
        clearInterval(pingInterval);
        if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const apiPost = async (payload) => {
      payload.partition = currentPartition;
      try {
          const res = await fetch('/api/command', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
          });
          if (!res.ok) {
              const err = await res.json();
              alert(`Error: ${err.detail}`);
          }
      } catch (e) {
          console.error("Command error:", e);
      }
  };

  const sendCommand = (action) => {
      let code = null;
      if (action === 'disarm') {
          code = prompt("Enter PIN code to disarm:");
          if (!code) return;
      }
      apiPost({ action, code });
  };

  const sendBypass = (zoneId) => {
      if(confirm(`Toggle bypass for Zone ${zoneId}?`)) {
          apiPost({ action: 'bypass', zone: zoneId });
      }
  };

  const sendPanic = (type) => {
      if(confirm(`WARNING! Activate ${type} Panic Alarm?`)) {
          apiPost({ action: 'panic', panic_type: type });
      }
  };

  const sendOutput = (num) => apiPost({ action: 'output', output_num: num });

  const handleSetCode = () => {
      if (!adminForm.master || !adminForm.slot || !adminForm.newPin) {
          alert("All fields required");
          return;
      }
      apiPost({ action: 'set_code', code: adminForm.master, user_slot: adminForm.slot, new_pin: adminForm.newPin });
      setAdminForm({ master: '', slot: '', newPin: '' });
      alert("Command sent");
  };

  const partitionData = data.partitions[currentPartition] || {};
  const isReady = partitionData.ready;
  const isAlarm = partitionData.alarm;

  // Compute status text
  let stateText = 'UNKNOWN';
  let stateClass = '';
  let subState = partitionData.partition_state || 'Waiting...';
  
  if (isAlarm) { stateText = 'ALARM'; stateClass = 'text-alarm'; subState = 'System in alarm state!'; }
  else if (partitionData.armed_away) { stateText = 'ARMED AWAY'; stateClass = 'text-armed'; subState = 'System is armed (Away)'; }
  else if (partitionData.armed_stay) { stateText = 'ARMED STAY'; stateClass = 'text-armed'; subState = 'System is armed (Stay)'; }
  else if (partitionData.exit_delay) { stateText = 'EXIT DELAY'; stateClass = 'text-not-ready'; subState = 'Please exit'; }
  else if (partitionData.entry_delay) { stateText = 'ENTRY DELAY'; stateClass = 'text-not-ready'; subState = 'Please disarm'; }
  else if (!isReady) { stateText = 'NOT READY'; stateClass = 'text-not-ready'; subState = 'Zones open/trouble'; }
  else if (isReady) { stateText = 'READY'; stateClass = 'text-ready'; subState = 'System ready'; }
  
  if (!data.connected) { stateText = 'Connecting...'; subState = 'Waiting for panel connection.'; stateClass = ''; }

  const openZoneNames = Object.entries(data.zones)
      .filter(([_, z]) => (z.open || z.fault) && !z.bypassed)
      .map(([id, z]) => `${z.name} (${id})`);

  const flags = [
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

  const visibleZones = useMemo(() => {
      let maxZ = 8;
      if (discoveryMode) {
          maxZ = 64;
      } else {
          Object.keys(data.zones).forEach(k => {
              if (data.zones[k].open || data.zones[k].fault || data.zones[k].bypassed || data.zones[k].alarm || data.zone_names[k]) {
                  maxZ = Math.max(maxZ, parseInt(k));
              }
          });
          maxZ = Math.ceil(maxZ / 8) * 8;
      }
      
      const res = [];
      for(let i=1; i<=maxZ; i++) {
          const z = data.zones[i] || {open: false, fault: false, alarm: false, bypassed: false, name: `Zone ${i}`, type: 'unknown', timer: -1};
          res.push({ id: i, ...z });
      }
      return res;
  }, [data.zones, data.zone_names, discoveryMode]);

  return (
    <>
      <div className="ambient-bg">
          <div className="glow glow-1"></div>
          <div className="glow glow-2"></div>
      </div>
      
      <div className="container fade-in-up">
          <header className="app-header">
                <div className="header-left">
                    <h1>Command Center</h1>
                    <p className="subtitle">DSC Envisalink EVL-4EZR (React UI)</p>
                </div>
                <div className="header-right">
                    <button className="btn-outline" onClick={() => setTheme(theme === 'modern' ? 'dsky' : 'modern')} style={{padding: '0.5rem 1rem', fontSize: '0.8rem'}}>
                        Theme: {theme === 'modern' ? 'Modern' : 'Apollo DSKY'}
                    </button>
                    <select className="partition-select" id="partition-selector" value={currentPartition} onChange={(e) => setCurrentPartition(parseInt(e.target.value))}>
                        {Object.keys(data.partitions).length > 0 ? Object.keys(data.partitions).map(p => (
                            <option key={p} value={p}>Partition {p}</option>
                        )) : <option value="1">Partition 1</option>}
                    </select>
                    <div className="connection-status">
                        <div className={`dot ${wsStatus === 'Live' ? 'connected' : 'disconnected'}`}></div>
                        <span>{wsStatus}</span>
                    </div>
                </div>
            </header>
            
            {(!isReady && openZoneNames.length > 0) && (
                <div className="debug-alert slide-down">
                    <div className="alert-content">
                        <span className="alert-icon">⚠️</span>
                        <div><strong>Action Required:</strong> {openZoneNames.join(", ")} must be closed.</div>
                    </div>
                    <button className="btn-ghost" onClick={() => sendCommand('bypass_all_open')}>Bypass All</button>
                </div>
            )}
            
            <main>
                <div className="dashboard-grid">
                    <div className="column main-col">
                        <div className="card panel-card">
                            <div className="status-ring">
                                <h2 className={`state-text ${stateClass}`}>{stateText}</h2>
                                <p className="sub-state">{subState}</p>
                            </div>
                            <div className="flags-container">
                                {flags.map(f => partitionData[f.key] ? (
                                    <div key={f.key} className={`flag ${f.key === 'trouble' ? 'active-warn' : 'active'}`}>{f.label}</div>
                                ) : null)}
                            </div>
                            
                            <div className="arming-controls">
                                <button className="btn btn-primary" onClick={() => { playBeep(theme); sendCommand('arm_stay'); }}>Arm Stay</button>
                                <button className="btn btn-success" onClick={() => { playBeep(theme); sendCommand('arm_away'); }}>Arm Away</button>
                                <button className="btn btn-purple" onClick={() => { playBeep(theme); sendCommand('arm_night'); }}>Night Mode</button>
                                <button className="btn btn-orange" onClick={() => { playBeep(theme); sendCommand('arm_max'); }}>Max Mode</button>
                                <button className="btn btn-danger btn-full" onClick={() => { playBeep(theme); sendCommand('disarm'); }}>Disarm System</button>
                            </div>
                        </div>

                        <div className="card keypad-card">
                            <div className="card-header"><h3>Keypad Access</h3></div>
                            <div className="keypad-wrapper">
                                <div className="keypad-display">
                                    <input type="password" value={keypadInput} readOnly placeholder="••••" />
                                    <button className="btn-icon" onClick={() => { playBeep(theme); setKeypadInput(''); }}>⌫</button>
                                </div>
                                <div className="keypad-grid">
                                    {['1','2','3','4','5','6','7','8','9','*','0','#'].map(k => (
                                        <button key={k} className={`key-btn ${k === '*' || k === '#' ? 'action-key' : ''}`} onClick={() => { playBeep(theme); setKeypadInput(prev => prev + k); }}>{k}</button>
                                    ))}
                                </div>
                                <button className="btn btn-outline btn-full action-key" onClick={() => { playBeep(theme); if(keypadInput) { apiPost({action: 'keypress', keys: keypadInput}); setKeypadInput(''); } }}>Transmit</button>
                            </div>
                        </div>

                        <div className="card admin-card">
                            <div className="card-header"><h3>System Administration</h3></div>
                            <div className="admin-grid">
                                <button className="btn-outline" onClick={() => { playBeep(theme); let c = prompt("Master Code:"); if(c) apiPost({action: 'sync_time', code: c}); }}>Sync Panel Time</button>
                                <button className="btn-outline" onClick={() => { playBeep(theme); sendCommand('macro_goodnight'); }}>Goodnight Routine</button>
                                <button className="btn-outline" onClick={() => { playBeep(theme); apiPost({action: 'keypress', keys: '*2'}); }}>System Troubles</button>
                            </div>
                            <div className="admin-form">
                                <h4>Manage Access Codes</h4>
                                <div className="code-inputs">
                                    <input type="password" placeholder="Master Code" value={adminForm.master} onChange={e => setAdminForm({...adminForm, master: e.target.value})} />
                                    <input type="text" placeholder="Slot (01-32)" value={adminForm.slot} onChange={e => setAdminForm({...adminForm, slot: e.target.value})} />
                                    <input type="password" placeholder="New PIN" value={adminForm.newPin} onChange={e => setAdminForm({...adminForm, newPin: e.target.value})} />
                                    <button className="btn-primary" onClick={handleSetCode}>Set</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="column side-col">
                        <div className="card zones-card">
                            <div className="card-header flex-between">
                                <h3>Zone Monitor</h3>
                                <div className="flex-gap">
                                    <button className={`btn-text ${discoveryMode ? 'active-debug' : ''}`} onClick={() => setDiscoveryMode(!discoveryMode)}>
                                        {discoveryMode ? 'Hide Unknown' : 'Debug Unknown'}
                                    </button>
                                    <button className="btn-text" onClick={() => sendCommand('bypass_all_open')}>Bypass Open</button>
                                </div>
                            </div>
                            <div className="zones-grid">
                                {visibleZones.map(z => {
                                    const isUnknown = !data.zone_names[z.id];
                                    let statusStr = 'Closed';
                                    let cardClass = 'zone-card';
                                    let style = {};
                                    
                                    if (z.alarm) { cardClass += ' alarm'; statusStr = 'Alarm'; }
                                    else if (z.open || z.fault) { cardClass += ' open'; statusStr = 'Open'; }
                                    else if (z.bypassed) { cardClass += ' bypassed'; statusStr = 'Bypassed'; }
                                    
                                    if (discoveryMode && isUnknown && (z.open || z.fault)) {
                                        style = { borderColor: 'var(--brand-purple)', boxShadow: '0 0 15px rgba(139, 92, 246, 0.4)' };
                                    }

                                    let icon = "";
                                    if (z.type === "opening") icon = "🚪 ";
                                    else if (z.type === "motion") icon = "🏃‍♂️ ";
                                    else if (z.type === "glass") icon = "🪟 ";
                                    else if (z.type === "smoke") icon = "🔥 ";

                                    return (
                                        <div key={z.id} className={cardClass} style={style} onClick={() => sendBypass(z.id)}>
                                            <div className="z-header">
                                                <span className="z-num">Z{z.id} &bull; {statusStr}</span>
                                                <div className="z-status-dot"></div>
                                            </div>
                                            <div className="z-name">{icon}{z.name}</div>
                                            {(discoveryMode && isUnknown) && <div style={{fontSize:'0.65rem', color:'var(--brand-purple)', textTransform:'uppercase', fontWeight:700}}>Unknown</div>}
                                            {z.timer >= 0 && <div className="z-time">{statusStr === 'Closed' ? 'Closed' : 'Opened'} {formatTime(z.timer)} ago</div>}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="card outputs-card">
                            <div className="card-header"><h3>Smart Relays (PGM)</h3></div>
                            <div className="outputs-grid">
                                {[1,2,3,4].map(n => (
                                    <button key={n} className="btn-output" onClick={() => sendOutput(n)}>Out {n}</button>
                                ))}
                            </div>
                        </div>

                        <div className="card activity-card">
                            <div className="card-header"><h3>System Log</h3></div>
                            <div className="activity-feed">
                                {data.events.map((ev, idx) => (
                                    <div key={idx} className="activity-item">
                                        <div className="activity-time">{ev.time}</div>
                                        <div className="activity-msg">{ev.message}</div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="card panic-card">
                            <div className="card-header"><h3>Emergency</h3></div>
                            <div className="panic-grid">
                                <button className="btn-panic panic-police" onClick={() => sendPanic('Police')}>Police</button>
                                <button className="btn-panic panic-fire" onClick={() => sendPanic('Fire')}>Fire</button>
                                <button className="btn-panic panic-med" onClick={() => sendPanic('Ambulance')}>Medical</button>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    </>
  );
}

export default App;
