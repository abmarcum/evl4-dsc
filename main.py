import asyncio
import json
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pyenvisalink.alarm_panel import EnvisalinkAlarmPanel
from fastapi.middleware.cors import CORSMiddleware
import os
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

config_path = os.path.join(os.path.dirname(__file__), 'config.json')
with open(config_path) as f:
    config = json.load(f)

panel = None
is_connected = False
connected_ws = set()
recent_events = []
zone_timers = {}

def add_event(message):
    timestamp = time.strftime("%I:%M:%S %p")
    recent_events.insert(0, {"time": timestamp, "message": message})
    if len(recent_events) > 50:
        recent_events.pop()
    trigger_broadcast()

def trigger_broadcast():
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(broadcast_state())
    except Exception as e:
        logger.error(f"Broadcast error: {e}")

def handle_login_success(data):
    global is_connected
    is_connected = True
    add_event("Successfully connected to Envisalink module.")

def handle_login_failure(data):
    global is_connected
    is_connected = False
    add_event("Failed to connect to Envisalink module.")

def handle_zone_change(zone):
    zone_timers[zone] = time.time()
    state = panel.alarm_state['zone'][zone]['status']
    status_str = "Open" if state.get('open') else "Closed"
    if state.get('alarm'): status_str = "in ALARM"
    z_info = config.get('zone_names', {}).get(str(zone))
    name = z_info.get("name", f"Zone {zone}") if isinstance(z_info, dict) else (z_info if isinstance(z_info, str) else f"Zone {zone}")
    add_event(f"{name} is now {status_str}.")

def handle_partition_change(partition):
    state = panel.alarm_state['partition'][partition]['status']
    state_str = state.get('partition_state', 'updated')
    add_event(f"Partition {partition}: {state_str}")

def handle_cid_event(event):
    add_event(f"System Event: {event}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    global panel
    loop = asyncio.get_running_loop()
    
    panel = EnvisalinkAlarmPanel(
        config['ip_address'],
        port=config['port'],
        panelType=config['panel_type'],
        envisalinkVersion=config['evl_version'],
        userName=config['username'],
        password=config['password'],
        eventLoop=loop,
        zoneBypassEnabled=True
    )
    
    panel.callback_login_success = handle_login_success
    panel.callback_login_failure = handle_login_failure
    panel.callback_zone_state_change = handle_zone_change
    panel.callback_partition_state_change = handle_partition_change
    panel.callback_realtime_cid_event = handle_cid_event
    
    panel.start()
    yield
    if panel:
        panel.stop()

app = FastAPI(lifespan=lifespan)

import re

cors_origins = config.get("cors_origins", [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
])

if any("*" in o for o in cors_origins):
    regex_parts = []
    for o in cors_origins:
        if o == "*":
            regex_parts.append(".*")
        else:
            regex_parts.append(re.escape(o).replace("\\*", ".*"))
    allow_origin_regex = "^(" + "|".join(regex_parts) + ")$"
    
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=allow_origin_regex,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

def get_current_state():
    if not panel or not is_connected:
        return {"connected": False, "partitions": {}, "zones": {}, "events": recent_events, "zone_names": config.get('zone_names', {})}
        
    partitions = {}
    for i in range(1, 9):
        if i in panel.alarm_state['partition']:
            p_status = panel.alarm_state['partition'][i]['status']
            if p_status.get('partition_state') != 'N/A' or p_status.get('ready'):
                partitions[i] = p_status
    if not partitions and 1 in panel.alarm_state['partition']:
        partitions[1] = panel.alarm_state['partition'][1]['status']
            
    zones = {}
    now = time.time()
    for i in range(1, 65):
        if i in panel.alarm_state['zone']:
            zone_status = panel.alarm_state['zone'][i]['status']
            last_change = zone_timers.get(i, 0)
            elapsed = int(now - last_change) if last_change > 0 else -1
            zones[i] = {
                "open": zone_status.get('open', False),
                "fault": zone_status.get('fault', False),
                "alarm": zone_status.get('alarm', False),
                "tamper": zone_status.get('tamper', False),
                "bypassed": panel.alarm_state['zone'][i].get('bypassed', False),
                "timer": elapsed
            }
            z_info = config.get('zone_names', {}).get(str(i))
            zones[i]["name"] = z_info.get("name", f"Zone {i}") if isinstance(z_info, dict) else (z_info if isinstance(z_info, str) else f"Zone {i}")
            zones[i]["type"] = z_info.get("type", "unknown") if isinstance(z_info, dict) else "unknown"

    return {
        "connected": True,
        "partitions": partitions,
        "zones": zones,
        "events": recent_events,
        "zone_names": config.get('zone_names', {})
    }

async def broadcast_state():
    if not connected_ws:
        return
    state = get_current_state()
    disconnected = set()
    for ws in connected_ws:
        try:
            await ws.send_json(state)
        except:
            disconnected.add(ws)
    for ws in disconnected:
        connected_ws.remove(ws)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_ws.add(websocket)
    await websocket.send_json(get_current_state())
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        connected_ws.remove(websocket)

# Fallback REST status for backward compatibility
@app.get("/api/status")
async def get_status():
    return get_current_state()

class CommandRequest(BaseModel):
    action: str
    code: str = None
    partition: int = 1
    zone: int = None
    panic_type: str = None
    keys: str = None
    output_num: int = None
    user_slot: str = None
    new_pin: str = None

@app.post("/api/command")
async def execute_command(req: CommandRequest):
    if not panel or not is_connected:
        raise HTTPException(status_code=503, detail="Panel not connected")
    
    code = req.code or config.get("code")
    partition = req.partition
    
    logger.info(f"Executing command: {req.action} on partition {partition}")
    
    if req.action == "arm_stay":
        panel.arm_stay_partition(code, partition)
    elif req.action == "arm_away":
        panel.arm_away_partition(code, partition)
    elif req.action == "arm_night":
        panel.arm_night_partition(code, partition)
    elif req.action == "arm_max":
        panel.arm_max_partition(code, partition)
    elif req.action == "disarm":
        if not code:
             raise HTTPException(status_code=400, detail="Code is required to disarm")
        panel.disarm_partition(code, partition)
    elif req.action == "bypass":
        if not req.zone:
            raise HTTPException(status_code=400, detail="Zone number is required for bypass")
        panel.toggle_zone_bypass(req.zone)
    elif req.action == "bypass_all_open":
        bypassed_count = 0
        for i in range(1, 65):
            if i in panel.alarm_state['zone']:
                zone_status = panel.alarm_state['zone'][i]['status']
                # If zone is open/faulted and NOT already bypassed, bypass it
                if (zone_status.get('open') or zone_status.get('fault')) and not panel.alarm_state['zone'][i].get('bypassed'):
                    panel.toggle_zone_bypass(i)
                    bypassed_count += 1
                    # Slight delay between rapid bypass commands
                    await asyncio.sleep(0.1)
        return {"status": "success", "action": req.action, "bypassed_count": bypassed_count}
    elif req.action == "panic":
        if req.panic_type not in ['Fire', 'Ambulance', 'Police']:
            raise HTTPException(status_code=400, detail="Invalid panic type")
        panel.panic_alarm(req.panic_type)
    elif req.action == "keypress":
        if not req.keys:
            raise HTTPException(status_code=400, detail="Keys are required for keypress action")
        panel.keypresses_to_partition(partition, req.keys)
    elif req.action == "output":
        if not req.output_num:
            raise HTTPException(status_code=400, detail="Output number required")
        panel.command_output(code, partition, req.output_num)
    elif req.action == "set_code":
        if not req.code or not req.user_slot or not req.new_pin:
            raise HTTPException(status_code=400, detail="Master code, user slot, and new pin required")
        slot = str(req.user_slot).zfill(2)
        pin = str(req.new_pin)
        seq = f"*5{req.code}{slot}{pin}#"
        panel.keypresses_to_partition(partition, seq)
    elif req.action == "sync_time":
        if not req.code:
             raise HTTPException(status_code=400, detail="Master code required")
        import datetime
        now = datetime.datetime.now()
        # DSC time format: HHMMMMDDYY (HH MM Month DD YY)
        time_str = now.strftime("%H%M%m%d%y")
        seq = f"*6{req.code}1{time_str}#"
        panel.keypresses_to_partition(partition, seq)
    elif req.action == "macro_goodnight":
        panel.arm_night_partition(code, partition)
        await asyncio.sleep(0.5)
        panel.command_output(code, partition, 1)
    else:
        raise HTTPException(status_code=400, detail="Unknown action")
        
    # Trigger a broadcast right after command
    trigger_broadcast()
    return {"status": "success", "action": req.action}

static_dir = os.path.join(os.path.dirname(__file__), 'static')
os.makedirs(static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/")
async def root():
    return FileResponse(os.path.join(static_dir, 'index.html'))
