// --- CONFIGURATION ---
const PX_PER_SEC = 30; 
const TRACK_COUNT_VIDEO = 3;
const TRACK_COUNT_AUDIO = 2;

// --- DOM ELEMENTS ---
const canvas = document.getElementById('previewCanvas');
const ctx = canvas.getContext('2d');
const rulerCanvas = document.getElementById('rulerCanvas');
const rulerCtx = rulerCanvas.getContext('2d');
const videoPool = document.getElementById('video-pool');
const endMarker = document.getElementById('endMarker');
const btnExport = document.getElementById('btnExport'); // Reference for UI updates

// --- STATE ---
const appState = {
    currentTime: 0,
    projectDuration: 30, 
    containerWidth: 60, 
    isPlaying: false,
    isExporting: false, // NEW: Track export state
    selectedClip: null,
    tracks: [], 
    dragging: null
};

// --- AUDIO ENGINE ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let activeAudioNodes = [];

// --- INITIALIZATION ---
function init() {
    appState.tracks = [];
    for(let i=0; i<TRACK_COUNT_VIDEO; i++) appState.tracks.push({ type: 'video', clips: [] });
    for(let i=0; i<TRACK_COUNT_AUDIO; i++) appState.tracks.push({ type: 'audio', clips: [] });

    renderTimelineTracks();
    refreshTimeline(); 
    loop();
}

// --- FILE UPLOAD ---
document.getElementById('inpVideo').onchange = async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = null; 
    for(let file of files) {
        const vid = document.createElement('video');
        vid.src = URL.createObjectURL(file);
        vid.muted = true; vid.preload = "auto";
        // Important: set crossOrigin to anonymous to avoid tainting canvas during export
        vid.crossOrigin = "anonymous"; 
        videoPool.appendChild(vid);
        await new Promise(r => { vid.onloadedmetadata = () => r(); vid.onerror = () => r(); });
        
        const clip = {
            id: 'c' + Math.random().toString(36).substr(2, 5),
            type: 'video', file: file, videoElement: vid,
            duration: vid.duration || 10, sourceDuration: vid.duration || 10,
            start: 0, offset: 0, opacity: 1, filter: 'none'
        };
        const track = appState.tracks[2]; 
        const lastClip = track.clips[track.clips.length-1];
        clip.start = lastClip ? lastClip.start + lastClip.duration : 0;
        track.clips.push(clip);
    }
    refreshTimeline();
};

document.getElementById('inpAudio').onchange = async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = null;
    for(let file of files) {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const clip = {
            id: 'c' + Math.random().toString(36).substr(2, 5),
            type: 'audio', file: file, buffer: audioBuffer,
            duration: audioBuffer.duration, sourceDuration: audioBuffer.duration,
            start: 0, offset: 0, volume: 1
        };
        const track = appState.tracks[3];
        const lastClip = track.clips[track.clips.length-1];
        clip.start = lastClip ? lastClip.start + lastClip.duration : 0;
        track.clips.push(clip);
    }
    refreshTimeline();
};

// --- DOM RENDERING ---
function renderTimelineTracks() {
    const container = document.getElementById('tracksContainer');
    container.innerHTML = '';
    for(let i=TRACK_COUNT_VIDEO-1; i>=0; i--) createTrackDiv(container, i, `Video ${i+1}`);
    for(let i=TRACK_COUNT_VIDEO; i<TRACK_COUNT_VIDEO+TRACK_COUNT_AUDIO; i++) createTrackDiv(container, i, `Audio ${i - TRACK_COUNT_VIDEO + 1}`);
}

function createTrackDiv(container, index, label) {
    const div = document.createElement('div');
    div.className = 'track';
    div.dataset.id = index;
    div.dataset.label = label;
    div.dataset.type = index < TRACK_COUNT_VIDEO ? 'video' : 'audio';
    container.appendChild(div);
}

function refreshTimeline() {
    if(appState.dragging && appState.dragging.action !== 'move-marker') return;

    let maxClipTime = 0;
    appState.tracks.forEach(t => t.clips.forEach(c => maxClipTime = Math.max(maxClipTime, c.start + c.duration)));
    appState.containerWidth = Math.max(maxClipTime + 10, appState.projectDuration + 10, 60);
    
    const wPx = appState.containerWidth * PX_PER_SEC;
    document.querySelectorAll('.track').forEach(t => t.style.width = wPx + 'px');
    updateRuler();

    endMarker.style.left = (appState.projectDuration * PX_PER_SEC) + 'px';

    if(appState.dragging && appState.dragging.action === 'move-marker') return;

    document.querySelectorAll('.clip').forEach(e => e.remove());
    appState.tracks.forEach((track, trackIdx) => {
        const trackDiv = document.querySelector(`.track[data-id="${trackIdx}"]`);
        track.clips.forEach(clip => {
            const el = document.createElement('div');
            el.className = `clip type-${clip.type}`;
            if(appState.selectedClip && appState.selectedClip.id === clip.id) el.classList.add('selected');
            el.style.left = (clip.start * PX_PER_SEC) + 'px';
            el.style.width = (clip.duration * PX_PER_SEC) + 'px';
            el.innerHTML = `<div class="trim-handle trim-l" data-action="trim-l"></div><div class="clip-name">${clip.file.name}</div><div class="trim-handle trim-r" data-action="trim-r"></div>`;
            el.onmousedown = (e) => handleClipMouseDown(e, clip, trackIdx, el);
            trackDiv.appendChild(el);
        });
    });
}

function updateRuler() {
    const width = appState.containerWidth * PX_PER_SEC;
    rulerCanvas.width = width;
    rulerCanvas.height = 30;
    const rc = rulerCtx;
    rc.fillStyle = '#222'; rc.fillRect(0,0,width,30);
    rc.strokeStyle = '#555'; rc.fillStyle = '#888'; rc.font = '10px monospace';
    
    for(let i=0; i<width; i+=PX_PER_SEC) {
        if((i/PX_PER_SEC)%5 === 0) {
            rc.beginPath(); rc.moveTo(i, 0); rc.lineTo(i, 20); rc.stroke();
            rc.fillText(formatTime(i/PX_PER_SEC), i+4, 12);
        } else {
            rc.beginPath(); rc.moveTo(i, 15); rc.lineTo(i, 25); rc.stroke();
        }
    }
}

// --- INTERACTION LOGIC ---
endMarker.onmousedown = (e) => {
    e.stopPropagation(); 
    appState.dragging = { action: 'move-marker', startX: e.clientX, originalTime: appState.projectDuration };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
};

function handleClipMouseDown(e, clip, trackIdx, el) {
    e.stopPropagation();
    appState.selectedClip = clip;
    updatePropertiesPanel();
    document.querySelectorAll('.clip').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
    
    appState.dragging = {
        clip: clip, domElement: el,
        startTrackIdx: trackIdx, currentTrackIdx: trackIdx,
        action: e.target.dataset.action || 'move',
        startX: e.clientX,
        originalStart: clip.start, originalDur: clip.duration, originalOffset: clip.offset
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e) {
    if(!appState.dragging) return;
    const d = appState.dragging;
    const deltaPx = e.clientX - d.startX;
    const deltaSec = deltaPx / PX_PER_SEC;

    if(d.action === 'move-marker') {
        appState.projectDuration = Math.max(1, d.originalTime + deltaSec);
        refreshTimeline(); 
        return;
    }

    if(d.action === 'move') {
        const newStart = Math.max(0, d.originalStart + deltaSec);
        d.domElement.style.left = (newStart * PX_PER_SEC) + 'px';
        const hoveredEl = document.elementFromPoint(e.clientX, e.clientY);
        const trackDiv = hoveredEl ? hoveredEl.closest('.track') : null;
        if(trackDiv) {
            const trackType = trackDiv.dataset.type;
            const trackId = parseInt(trackDiv.dataset.id);
            if(trackType === d.clip.type && trackId !== d.currentTrackIdx) {
                trackDiv.appendChild(d.domElement);
                document.querySelectorAll('.track').forEach(t => t.classList.remove('drag-over'));
                trackDiv.classList.add('drag-over');
                d.currentTrackIdx = trackId;
            }
        }
    } else if (d.action === 'trim-l') {
        const newDur = d.originalDur - deltaSec;
        if(newDur > 0.1 && d.originalOffset + deltaSec >= 0) {
            d.domElement.style.left = ((d.originalStart + deltaSec) * PX_PER_SEC) + 'px';
            d.domElement.style.width = (newDur * PX_PER_SEC) + 'px';
        }
    } else if (d.action === 'trim-r') {
        const newDur = d.originalDur + deltaSec;
        if(newDur > 0.1 && newDur <= (d.clip.sourceDuration - d.clip.offset)) {
            d.domElement.style.width = (newDur * PX_PER_SEC) + 'px';
        }
    }
}

function onMouseUp(e) {
    if(!appState.dragging) return;
    const d = appState.dragging;

    if(d.action !== 'move-marker') {
        const deltaPx = e.clientX - d.startX;
        const deltaSec = deltaPx / PX_PER_SEC;
        
        if(d.action === 'move') {
            d.clip.start = Math.max(0, d.originalStart + deltaSec);
            if(d.currentTrackIdx !== d.startTrackIdx) {
                const oldTrack = appState.tracks[d.startTrackIdx];
                oldTrack.clips.splice(oldTrack.clips.indexOf(d.clip), 1);
                appState.tracks[d.currentTrackIdx].clips.push(d.clip);
            }
        } else if (d.action === 'trim-l') {
            const newDur = d.originalDur - deltaSec;
            if(newDur > 0.1 && d.originalOffset + deltaSec >= 0) {
                d.clip.start = d.originalStart + deltaSec;
                d.clip.duration = newDur;
                d.clip.offset = d.originalOffset + deltaSec;
            }
        } else if (d.action === 'trim-r') {
            const newDur = d.originalDur + deltaSec;
            if(newDur > 0.1 && newDur <= (d.clip.sourceDuration - d.clip.offset)) {
                d.clip.duration = newDur;
            }
        }
        document.querySelectorAll('.track').forEach(t => t.classList.remove('drag-over'));
    }

    appState.dragging = null;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    refreshTimeline();
    drawPreview();
}

// --- PLAYBACK ENGINE ---
function loop() {
    if(appState.isPlaying) {
        // Render Audio chunks are handled by WebAudio scheduler, 
        // we just update UI time here.
        appState.currentTime += 0.033; // ~30FPS
        
        if(appState.currentTime >= appState.projectDuration) {
            // STOP at End
            if(appState.isExporting) {
                // Export logic handles the stop
            } else {
                appState.currentTime = 0; // Loop in editor
                startAudio();
            }
        }
        
        const scroll = document.getElementById('timelineScroll');
        if(appState.currentTime * PX_PER_SEC > scroll.scrollLeft + scroll.clientWidth) {
            scroll.scrollLeft = (appState.currentTime * PX_PER_SEC) - 50;
        }
    }
    drawPreview();
    requestAnimationFrame(loop);
}

// --- AUDIO LOGIC ---
function stopAudio() {
    activeAudioNodes.forEach(n => { try { n.stop(); } catch(e){} });
    activeAudioNodes = [];
}

// NEW: Accepts a specific output destination (for export)
function startAudio(outputDestination = null) {
    stopAudio();
    if(audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    
    // Default to speakers if not exporting
    const finalDest = outputDestination || audioCtx.destination;

    for(let i=TRACK_COUNT_VIDEO; i<appState.tracks.length; i++) {
        appState.tracks[i].clips.forEach(clip => {
            // Check overlaps
            const clipEnd = clip.start + clip.duration;
            if(clipEnd > appState.currentTime && clip.start < appState.projectDuration) {
                
                let startOffset = clip.offset;
                let startTime = now;
                
                if(clip.start > appState.currentTime) {
                    startTime += (clip.start - appState.currentTime);
                } else {
                    startOffset += (appState.currentTime - clip.start);
                }
                
                // Cut off if exceeds project duration
                let dur = clip.duration - (startOffset - clip.offset);
                const timeUntilProjectEnd = appState.projectDuration - Math.max(clip.start, appState.currentTime);
                dur = Math.min(dur, timeUntilProjectEnd);

                if(dur > 0) {
                    const src = audioCtx.createBufferSource();
                    src.buffer = clip.buffer;
                    const gain = audioCtx.createGain();
                    gain.gain.value = clip.volume;
                    
                    src.connect(gain);
                    // CONNECT TO SPEAKERS OR EXPORT STREAM
                    gain.connect(finalDest);
                    
                    try {
                        src.start(startTime, startOffset, dur);
                        activeAudioNodes.push(src);
                    } catch(e) { console.warn("Audio schedule error", e); }
                }
            }
        });
    }
}

document.getElementById('playPause').onclick = () => {
    appState.isPlaying = !appState.isPlaying;
    if(appState.isPlaying) {
        document.getElementById('playPause').innerText = "❚❚";
        startAudio();
    } else {
        document.getElementById('playPause').innerText = "▶";
        stopAudio();
    }
};

document.getElementById('toStart').onclick = () => {
    appState.isPlaying = false;
    appState.currentTime = 0;
    stopAudio();
    document.getElementById('playPause').innerText = "▶";
    drawPreview();
};

document.getElementById('timelineScroll').addEventListener('mousedown', (e) => {
    if(e.target.id === 'endMarker') return;
    if(e.target.className === 'tracks-scroll' || e.target.className === 'track') {
        const r = document.getElementById('tracksContainer').getBoundingClientRect();
        appState.currentTime = Math.max(0, (e.clientX - r.left) / PX_PER_SEC);
        if(appState.isPlaying) startAudio();
        drawPreview();
    }
});

// --- RENDER VISUALS ---
function drawPreview() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0,0, canvas.width, canvas.height);
    
    for(let i=0; i<TRACK_COUNT_VIDEO; i++) {
        const track = appState.tracks[i];
        const clip = track.clips.find(c => appState.currentTime >= c.start && appState.currentTime < c.start + c.duration);
        if(clip) {
            const vid = clip.videoElement;
            const vidTime = (appState.currentTime - clip.start) + clip.offset;
            
            // Sync logic
            if(!appState.isExporting && Math.abs(vid.currentTime - vidTime) > 0.2) {
                vid.currentTime = vidTime;
            } else if (appState.isExporting) {
                // Precise seek for export
                vid.currentTime = vidTime;
            }
            
            ctx.save();
            ctx.globalAlpha = clip.opacity;
            let f = '';
            if(clip.filter === 'bw') f += 'grayscale(100%) ';
            if(clip.filter === '35mm') f += 'sepia(40%) contrast(1.2) ';
            if(clip.filter === 'invert') f += 'invert(100%) ';
            if(clip.filter === 'vhs') f += 'saturate(2) contrast(1.3) hue-rotate(-10deg) ';
            ctx.filter = f;

            const scale = Math.min(canvas.width / vid.videoWidth, canvas.height / vid.videoHeight);
            const w = vid.videoWidth * scale;
            const h = vid.videoHeight * scale;
            ctx.drawImage(vid, (canvas.width-w)/2, (canvas.height-h)/2, w, h);
            ctx.restore();
        }
    }
    document.getElementById('playhead').style.left = (appState.currentTime * PX_PER_SEC) + 'px';
    document.getElementById('timecode').innerText = formatTime(appState.currentTime);
}

// --- PROPERTIES & EXPORT ---
function updatePropertiesPanel() {
    const c = appState.selectedClip;
    if(!c) { document.getElementById('propertiesPanel').classList.add('hidden'); return; }
    document.getElementById('propertiesPanel').classList.remove('hidden');
    document.getElementById('propVolume').value = c.volume || 1;
    document.getElementById('propOpacity').value = c.opacity || 1;
    document.getElementById('propFilter').value = c.filter || 'none';
}
document.getElementById('propOpacity').oninput = (e) => { if(appState.selectedClip) appState.selectedClip.opacity = e.target.value; };
document.getElementById('propVolume').oninput = (e) => { if(appState.selectedClip) appState.selectedClip.volume = e.target.value; };
document.getElementById('propFilter').onchange = (e) => { if(appState.selectedClip) appState.selectedClip.filter = e.target.value; };
document.getElementById('btnDelete').onclick = () => {
    if(appState.selectedClip) {
        appState.tracks.forEach(t => {
            const i = t.clips.indexOf(appState.selectedClip);
            if(i > -1) t.clips.splice(i, 1);
        });
        appState.selectedClip = null;
        refreshTimeline();
    }
};

// --- ROBUST EXPORT LOGIC ---
btnExport.onclick = () => {
    // 1. Reset State
    appState.isPlaying = false;
    appState.isExporting = true;
    stopAudio();
    appState.currentTime = 0;
    
    // 2. Select Supported Mime Type
    const types = [
        "video/mp4", // Attempt MP4 (Safari)
        "video/webm;codecs=h264",
        "video/webm;codecs=vp9", 
        "video/webm" // Fallback
    ];
    let selectedType = types.find(t => MediaRecorder.isTypeSupported(t)) || "video/webm";
    
    // Determine extension based on selected type
    let ext = selectedType.includes("mp4") ? "mp4" : "webm";
    
    // 3. Setup Recorder
    const stream = canvas.captureStream(30); // 30 FPS
    const dest = audioCtx.createMediaStreamDestination(); // Audio sink
    
    // Combine Video + Audio
    const combinedStream = new MediaStream([
        ...stream.getVideoTracks(),
        ...dest.stream.getAudioTracks()
    ]);
    
    const recorder = new MediaRecorder(combinedStream, {
        mimeType: selectedType,
        videoBitsPerSecond: 8000000 // High Quality
    });
    
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    
    recorder.onstop = () => {
        appState.isExporting = false;
        appState.isPlaying = false;
        stopAudio();
        btnExport.innerText = "Export Project";
        document.getElementById('playPause').innerText = "▶";
        
        const blob = new Blob(chunks, { type: selectedType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `my_movie.${ext}`;
        a.click();
    };
    
    // 4. Start
    btnExport.innerText = "Rendering...";
    recorder.start();
    
    // 5. Playback Logic
    appState.isPlaying = true;
    startAudio(dest); // ROUTE AUDIO TO RECORDER, NOT SPEAKERS
    
    const checkEnd = setInterval(() => {
        if(!appState.isExporting || appState.currentTime >= appState.projectDuration) {
            recorder.stop();
            clearInterval(checkEnd);
        }
    }, 100);
};

const formatTime = t => new Date(t*1000).toISOString().substr(14, 5);

init();