// ==========================================
// CONFIGURATION & SETUP
// ==========================================
const PX_PER_SEC = 30; 
const TRACK_COUNT_VIDEO = 3;
const TRACK_COUNT_AUDIO = 2;

// DOM Elements
const canvas = document.getElementById('previewCanvas');
const ctx = canvas.getContext('2d');
const rulerCanvas = document.getElementById('rulerCanvas');
const rulerCtx = rulerCanvas.getContext('2d');
const videoPool = document.getElementById('video-pool');
const endMarker = document.getElementById('endMarker');
const btnExport = document.getElementById('btnExport');

// Application State
const appState = {
    currentTime: 0,
    projectDuration: 30, // Default 30s
    containerWidth: 60, 
    isPlaying: false,
    isExporting: false,
    selectedClip: null,
    tracks: [], 
    dragging: null
};

// Audio Engine
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();
let activeAudioNodes = [];

// ==========================================
// INITIALIZATION
// ==========================================
function init() {
    appState.tracks = [];
    
    // Create Data Structure for Tracks
    for(let i=0; i<TRACK_COUNT_VIDEO; i++) appState.tracks.push({ type: 'video', clips: [] });
    for(let i=0; i<TRACK_COUNT_AUDIO; i++) appState.tracks.push({ type: 'audio', clips: [] });

    renderTimelineStructure();
    refreshTimeline(); 
    requestAnimationFrame(loop);
}

// ==========================================
// FILE UPLOAD HANDLING
// ==========================================
document.getElementById('inpVideo').onchange = async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = null; 
    
    for(let file of files) {
        const vid = document.createElement('video');
        vid.src = URL.createObjectURL(file);
        vid.muted = true; vid.preload = "auto"; vid.crossOrigin = "anonymous"; 
        vid.setAttribute('playsinline', ''); 
        
        videoPool.appendChild(vid);
        
        await new Promise(resolve => { 
            vid.onloadedmetadata = () => resolve(); 
            vid.onerror = () => resolve();
            setTimeout(resolve, 1000); 
        });
        
        const dur = (vid.duration && isFinite(vid.duration)) ? vid.duration : 10;
        
        const clip = {
            id: 'c' + Math.random().toString(36).substr(2, 6),
            type: 'video', 
            file: file, 
            videoElement: vid,
            duration: dur, 
            sourceDuration: dur,
            start: 0, offset: 0, opacity: 1, filter: 'none',
            playbackRate: 1.0 // NEW
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
            id: 'c' + Math.random().toString(36).substr(2, 6),
            type: 'audio', 
            file: file, 
            buffer: audioBuffer,
            duration: audioBuffer.duration, 
            sourceDuration: audioBuffer.duration,
            start: 0, offset: 0, volume: 1,
            playbackRate: 1.0 // NEW
        };
        
        const track = appState.tracks[3];
        const lastClip = track.clips[track.clips.length-1];
        clip.start = lastClip ? lastClip.start + lastClip.duration : 0;
        track.clips.push(clip);
    }
    refreshTimeline();
};

// ==========================================
// TIMELINE RENDERING
// ==========================================
function renderTimelineStructure() {
    const container = document.getElementById('tracksContainer');
    container.innerHTML = '';
    
    for(let i=TRACK_COUNT_VIDEO-1; i>=0; i--) createTrackDOM(container, i, `Video ${i+1}`);
    for(let i=TRACK_COUNT_VIDEO; i<TRACK_COUNT_VIDEO+TRACK_COUNT_AUDIO; i++) createTrackDOM(container, i, `Audio ${i - TRACK_COUNT_VIDEO + 1}`);
}

function createTrackDOM(container, index, label) {
    const div = document.createElement('div');
    div.className = 'track';
    div.dataset.id = index;
    div.dataset.label = label;
    div.dataset.type = index < TRACK_COUNT_VIDEO ? 'video' : 'audio';
    container.appendChild(div);
}

function refreshTimeline() {
    if(appState.dragging && appState.dragging.action === 'move-marker') return;

    // Calculate Max Width
    let maxClipTime = 0;
    appState.tracks.forEach(t => t.clips.forEach(c => maxClipTime = Math.max(maxClipTime, c.start + c.duration)));
    appState.containerWidth = Math.max(maxClipTime + 10, appState.projectDuration + 10, 60);
    
    const wPx = appState.containerWidth * PX_PER_SEC;
    document.querySelectorAll('.track').forEach(t => t.style.width = wPx + 'px');
    updateRuler();

    endMarker.style.left = (appState.projectDuration * PX_PER_SEC) + 'px';

    // Render Clips
    document.querySelectorAll('.clip').forEach(e => e.remove());
    
    appState.tracks.forEach((track, trackIdx) => {
        const trackDiv = document.querySelector(`.track[data-id="${trackIdx}"]`);
        
        track.clips.forEach(clip => {
            const el = document.createElement('div');
            el.className = `clip type-${clip.type}`;
            if(appState.selectedClip && appState.selectedClip.id === clip.id) el.classList.add('selected');
            
            el.style.left = (clip.start * PX_PER_SEC) + 'px';
            el.style.width = (clip.duration * PX_PER_SEC) + 'px';
            
            // Labels
            let speedBadge = clip.playbackRate !== 1 ? `<span style="opacity:0.7">(${clip.playbackRate}x)</span> ` : '';

            el.innerHTML = `
                <div class="trim-handle trim-l" data-action="trim-l"></div>
                <div class="clip-name">${speedBadge}${clip.file.name}</div>
                <div class="trim-handle trim-r" data-action="trim-r"></div>
            `;
            
            addPointerListener(el, (e) => handleClipStart(e, clip, trackIdx, el));
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

// ==========================================
// POINTER EVENTS
// ==========================================
function addPointerListener(element, handler) {
    element.addEventListener('mousedown', handler);
    element.addEventListener('touchstart', handler, { passive: false });
}

function getPointerPos(e) {
    if(e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
}

// END MARKER
addPointerListener(endMarker, (e) => {
    e.stopPropagation();
    if(e.cancelable) e.preventDefault();
    const pos = getPointerPos(e);
    
    appState.dragging = { 
        action: 'move-marker', startX: pos.x, originalTime: appState.projectDuration 
    };
    bindDragEvents();
});

// CLIP INTERACTION
function handleClipStart(e, clip, trackIdx, el) {
    e.stopPropagation();
    if(e.type === 'touchstart' && e.cancelable) e.preventDefault(); 
    
    appState.selectedClip = clip;
    updatePropertiesPanel();
    document.querySelectorAll('.clip').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
    
    const pos = getPointerPos(e);
    
    appState.dragging = {
        clip: clip, domElement: el,
        startTrackIdx: trackIdx, currentTrackIdx: trackIdx,
        action: e.target.dataset.action || 'move',
        startX: pos.x,
        originalStart: clip.start, 
        originalDur: clip.duration, 
        originalOffset: clip.offset
    };
    bindDragEvents();
}

function bindDragEvents() {
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchend', onPointerUp);
}

function onPointerMove(e) {
    if(!appState.dragging) return;
    if(e.cancelable) e.preventDefault(); 

    const d = appState.dragging;
    const pos = getPointerPos(e);
    const deltaPx = pos.x - d.startX;
    const deltaSec = deltaPx / PX_PER_SEC;

    if(d.action === 'move-marker') {
        appState.projectDuration = Math.max(1, d.originalTime + deltaSec);
        refreshTimeline(); 
        return;
    }

    if(d.action === 'move') {
        const newStart = Math.max(0, d.originalStart + deltaSec);
        d.domElement.style.left = (newStart * PX_PER_SEC) + 'px';
        
        const hoveredEl = document.elementFromPoint(pos.x, pos.y);
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
    } 
    else if (d.action === 'trim-l') {
        // Trim Left: duration shrinks, start moves right, offset increases
        const newDur = d.originalDur - deltaSec;
        // Check limits. Offset cannot represent more than source available.
        // Limit logic: d.originalOffset + deltaSec >= 0
        if(newDur > 0.1 && (d.originalOffset + deltaSec * d.clip.playbackRate) >= 0) {
            d.domElement.style.left = ((d.originalStart + deltaSec) * PX_PER_SEC) + 'px';
            d.domElement.style.width = (newDur * PX_PER_SEC) + 'px';
        }
    } 
    else if (d.action === 'trim-r') {
        // Trim Right: duration grows/shrinks
        const newDur = d.originalDur + deltaSec;
        // Max Timeline Duration = (SourceDuration - Offset) / PlaybackRate
        const maxDur = (d.clip.sourceDuration - d.clip.offset) / d.clip.playbackRate;
        
        if(newDur > 0.1 && newDur <= maxDur) {
            d.domElement.style.width = (newDur * PX_PER_SEC) + 'px';
        }
    }
}

function onPointerUp(e) {
    if(!appState.dragging) return;
    const d = appState.dragging;

    if(d.action !== 'move-marker') {
        const currentLeftPx = parseFloat(d.domElement.style.left);
        const currentWidthPx = parseFloat(d.domElement.style.width);
        
        const finalStart = currentLeftPx / PX_PER_SEC;
        const finalDur = currentWidthPx / PX_PER_SEC;

        if(d.action === 'move') {
            d.clip.start = Math.max(0, finalStart);
            if(d.currentTrackIdx !== d.startTrackIdx) {
                const oldTrack = appState.tracks[d.startTrackIdx];
                oldTrack.clips.splice(oldTrack.clips.indexOf(d.clip), 1);
                appState.tracks[d.currentTrackIdx].clips.push(d.clip);
            }
        } else if (d.action === 'trim-l') {
            const diff = d.originalDur - finalDur;
            d.clip.start = d.originalStart + diff;
            d.clip.duration = finalDur;
            // Adjust offset based on speed
            d.clip.offset = d.originalOffset + (diff * d.clip.playbackRate);
        } else if (d.action === 'trim-r') {
            d.clip.duration = finalDur;
        }
        
        document.querySelectorAll('.track').forEach(t => t.classList.remove('drag-over'));
    }

    appState.dragging = null;
    window.removeEventListener('mousemove', onPointerMove);
    window.removeEventListener('touchmove', onPointerMove);
    window.removeEventListener('mouseup', onPointerUp);
    window.removeEventListener('touchend', onPointerUp);
    
    refreshTimeline();
    drawPreview();
}

// Scrubbing
document.getElementById('timelineScroll').addEventListener('click', (e) => {
    if(e.target.closest('.clip') || e.target.id === 'endMarker') return;
    const r = document.getElementById('tracksContainer').getBoundingClientRect();
    appState.currentTime = Math.max(0, (e.clientX - r.left) / PX_PER_SEC);
    if(appState.isPlaying) startAudio();
    drawPreview();
});

// ==========================================
// PLAYBACK ENGINE
// ==========================================
function loop() {
    if(appState.isPlaying) {
        appState.currentTime += 0.033;
        
        if(appState.currentTime >= appState.projectDuration) {
            if(!appState.isExporting) {
                appState.currentTime = 0;
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

function stopAudio() {
    activeAudioNodes.forEach(n => { try { n.stop(); } catch(e){} });
    activeAudioNodes = [];
}

function startAudio(outputDestination = null) {
    stopAudio();
    if(audioCtx.state === 'suspended') audioCtx.resume();
    
    const now = audioCtx.currentTime;
    const finalDest = outputDestination || audioCtx.destination;

    for(let i=TRACK_COUNT_VIDEO; i<appState.tracks.length; i++) {
        appState.tracks[i].clips.forEach(clip => {
            const clipEnd = clip.start + clip.duration;
            if(clipEnd > appState.currentTime && clip.start < appState.projectDuration) {
                
                let startOffset = clip.offset; // Source seconds
                let startTime = now;
                
                if(clip.start > appState.currentTime) {
                    startTime += (clip.start - appState.currentTime);
                } else {
                    // We are playing mid-clip.
                    // Timeline Time Elapsed = appState.currentTime - clip.start
                    // Source Time Elapsed = Timeline Time Elapsed * Rate
                    const timelineElapsed = appState.currentTime - clip.start;
                    startOffset += (timelineElapsed * clip.playbackRate);
                }
                
                // Duration Calculation
                let dur = clip.duration - (startOffset - clip.offset) / clip.playbackRate;
                
                // Cut at Project End
                const remainingProjectTime = appState.projectDuration - Math.max(clip.start, appState.currentTime);
                dur = Math.min(dur, remainingProjectTime);

                if(dur > 0) {
                    const src = audioCtx.createBufferSource();
                    src.buffer = clip.buffer;
                    src.playbackRate.value = clip.playbackRate; // SPEED
                    
                    const gain = audioCtx.createGain();
                    gain.gain.value = clip.volume;
                    
                    src.connect(gain);
                    gain.connect(finalDest);
                    
                    try {
                        src.start(startTime, startOffset, dur);
                        activeAudioNodes.push(src);
                    } catch(e) {}
                }
            }
        });
    }
}

// ==========================================
// VISUAL RENDERING
// ==========================================
function drawPreview() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0,0, canvas.width, canvas.height);
    
    for(let i=0; i<TRACK_COUNT_VIDEO; i++) {
        const track = appState.tracks[i];
        const clip = track.clips.find(c => appState.currentTime >= c.start && appState.currentTime < c.start + c.duration);
        
        if(clip) {
            const vid = clip.videoElement;
            
            // Calculate Source Time based on Speed
            // time = offset + (timeIntoClip * rate)
            const timeIntoClip = appState.currentTime - clip.start;
            const vidTime = clip.offset + (timeIntoClip * clip.playbackRate);
            
            if(!appState.isExporting && Math.abs(vid.currentTime - vidTime) > 0.25) vid.currentTime = vidTime;
            else if (appState.isExporting) vid.currentTime = vidTime;
            
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

// ==========================================
// UI & ACTIONS
// ==========================================
function updatePropertiesPanel() {
    const c = appState.selectedClip;
    if(!c) { document.getElementById('propertiesPanel').classList.add('hidden'); return; }
    
    document.getElementById('propertiesPanel').classList.remove('hidden');
    document.getElementById('propVolume').value = c.volume || 1;
    document.getElementById('propOpacity').value = c.opacity || 1;
    document.getElementById('propFilter').value = c.filter || 'none';
    
    // Speed Update
    const speed = c.playbackRate || 1;
    document.getElementById('propSpeed').value = speed;
    document.getElementById('speedVal').innerText = speed + 'x';
    
    // Hide Opacity for Audio
    if(c.type === 'audio') document.getElementById('propOpacity').parentElement.style.display = 'none';
    else document.getElementById('propOpacity').parentElement.style.display = 'block';
}

document.getElementById('propOpacity').oninput = (e) => { if(appState.selectedClip) appState.selectedClip.opacity = e.target.value; };
document.getElementById('propVolume').oninput = (e) => { if(appState.selectedClip) appState.selectedClip.volume = e.target.value; };
document.getElementById('propFilter').onchange = (e) => { if(appState.selectedClip) appState.selectedClip.filter = e.target.value; };

// SPEED CHANGE
document.getElementById('propSpeed').oninput = (e) => {
    if(appState.selectedClip) {
        const newRate = parseFloat(e.target.value);
        const c = appState.selectedClip;
        
        // 1. Calculate how much source material is currently being used
        const sourceUsed = c.duration * c.playbackRate;
        
        // 2. Update Rate
        c.playbackRate = newRate;
        document.getElementById('speedVal').innerText = newRate + 'x';
        
        // 3. Update Timeline Duration to maintain the same source usage
        c.duration = sourceUsed / newRate;
        
        refreshTimeline();
        if(appState.isPlaying) startAudio(); // Restart audio engine with new rate
    }
};

// DUPLICATE
document.getElementById('btnDuplicate').onclick = () => {
    if(appState.selectedClip) {
        const c = appState.selectedClip;
        const trackIdx = appState.tracks.findIndex(t => t.clips.includes(c));
        if(trackIdx === -1) return;
        
        // Clone object
        const clone = { ...c };
        clone.id = 'c' + Math.random().toString(36).substr(2, 6);
        
        // Place after original
        clone.start = c.start + c.duration;
        
        // Add to track
        appState.tracks[trackIdx].clips.push(clone);
        
        // Select the new one
        appState.selectedClip = clone;
        refreshTimeline();
        updatePropertiesPanel();
    }
};

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

// EXPORT
btnExport.onclick = () => {
    appState.isPlaying = false;
    appState.isExporting = true;
    stopAudio();
    appState.currentTime = 0;
    
    const types = ["video/mp4", "video/webm;codecs=h264", "video/webm;codecs=vp9", "video/webm"];
    let selectedType = types.find(t => MediaRecorder.isTypeSupported(t)) || "video/webm";
    let ext = selectedType.includes("mp4") ? "mp4" : "webm";
    
    const stream = canvas.captureStream(30);
    const dest = audioCtx.createMediaStreamDestination();
    
    const combinedStream = new MediaStream([
        ...stream.getVideoTracks(),
        ...dest.stream.getAudioTracks()
    ]);
    
    const recorder = new MediaRecorder(combinedStream, { mimeType: selectedType, videoBitsPerSecond: 8000000 });
    const chunks = [];
    recorder.ondataavailable = e => { if(e.data.size > 0) chunks.push(e.data); };
    
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
        a.download = `project.${ext}`;
        a.click();
    };
    
    btnExport.innerText = "Rendering...";
    recorder.start();
    appState.isPlaying = true;
    startAudio(dest);
    
    const checkEnd = setInterval(() => {
        if(!appState.isExporting || appState.currentTime >= appState.projectDuration) {
            recorder.stop();
            clearInterval(checkEnd);
        }
    }, 100);
};

// CONTROLS
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

window.addEventListener('resize', () => { refreshTimeline(); drawPreview(); });
window.addEventListener('keydown', (e) => {
    if(e.target.tagName === 'INPUT') return;
    if(e.code === 'Space') { e.preventDefault(); document.getElementById('playPause').click(); }
    if(e.code === 'Delete' || e.code === 'Backspace') document.getElementById('btnDelete').click();
});

const formatTime = t => new Date(t*1000).toISOString().substr(14, 5);
init();