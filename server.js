const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use('/public', express.static(__dirname + '/public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

const rooms = {}; 

function handlePlayerLeave(socket) {
    let targetRoomId = null;
    for (const roomId in rooms) {
        if (rooms[roomId].players.find(p => p.id === socket.id)) { targetRoomId = roomId; break; }
    }
    if (!targetRoomId) return;
    const room = rooms[targetRoomId];
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) { delete rooms[targetRoomId]; return; }
    if (room.hostId === socket.id) { room.hostId = room.players[0].id; io.to(room.hostId).emit('youAreHost'); }
    io.to(targetRoomId).emit('updatePlayers', room.players);

    if (room.phase === 'drafting') {
        const expectedCount = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).length;
        const submittedCount = Object.keys(room.currentPicks).filter(id => room.players.find(p => p.id === id)).length;

        if (expectedCount > 0 && submittedCount >= expectedCount) {
            room.phase = 'revealing'; 
            const picksForHost = room.players
                .filter(p => !room.roundSuccessMembers.has(p.id))
                .map(p => ({ id: p.id, name: p.name, image: room.currentPicks[p.id] || null }));
            io.to(targetRoomId).emit('startWhiteboardReveal', picksForHost);
        }
    }
}

io.on('connection', (socket) => {
    socket.on('joinRoomRequest', (password) => {
        if (!rooms[password]) { 
            rooms[password] = { 
                hostId: socket.id, players: [], finalDraftLog: {}, 
                roundSuccessMembers: new Set(), currentPicks: {}, 
                roundResultsList: {}, theme: "", maxRounds: 1,
                phase: 'waiting',
                renominationCount: 0 
            }; 
        }
        if (rooms[password].players.length >= 10) { socket.emit('roomError', 'この部屋は満員（最大10人）です！'); return; }
        socket.join(password);
        socket.emit('roomJoinedOk', password);
    });

    socket.on('join', (roomId, name) => {
        const room = rooms[roomId]; if (!room) return;

        const suffixes = ['', 'α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι'];
        let baseName = name;
        let suffixIdx = 0;
        let finalName = name;
        while (room.players.find(p => p.name === finalName)) {
            suffixIdx++;
            finalName = baseName + (suffixes[suffixIdx] || `(${suffixIdx})`);
        }

        room.players.push({ id: socket.id, name: finalName });
        if (!room.finalDraftLog[finalName]) room.finalDraftLog[finalName] = [];
        
        io.to(roomId).emit('updatePlayers', room.players);
        socket.emit('nameAssigned', finalName); 

        if (socket.id === room.hostId) socket.emit('youAreHost'); else socket.emit('youAreNotHost');
    });

    socket.on('leaveRoom', () => { handlePlayerLeave(socket); for (const room of socket.rooms) { if (room !== socket.id) socket.leave(room); } });
    socket.on('disconnect', () => { handlePlayerLeave(socket); });

    // ★追加：司会者によるゴーストプレイヤーの強制退室
    socket.on('kickPlayer', (roomId, targetId) => {
        const room = rooms[roomId]; if (!room) return;
        if (socket.id !== room.hostId) return; // 司会者のみ実行可能
        
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
            targetSocket.disconnect(true);
        } else {
            room.players = room.players.filter(p => p.id !== targetId);
            io.to(roomId).emit('updatePlayers', room.players);
        }
    });

    socket.on('startMeeting', (roomId, settings) => {
        const room = rooms[roomId]; if (!room) return;
        room.theme = settings.theme; room.maxRounds = settings.rounds;
        room.players.sort(() => Math.random() - 0.5);
        io.to(roomId).emit('meetingStarted', { players: room.players, theme: room.theme, rounds: room.maxRounds });
    });

    socket.on('startRound', (roomId, roundNumber, seconds, isRenomination = false) => {
        const room = rooms[roomId]; if (!room) return;
        room.phase = 'drafting'; 
        room.currentPicks = {}; 
        
        if (!isRenomination) {
            room.roundSuccessMembers.clear();
            room.roundResultsList = {}; 
            room.renominationCount = 0; 
        } else {
            room.renominationCount++; 
        }
        io.to(roomId).emit('startTimer', { seconds: seconds, currentRound: roundNumber, successMembers: Array.from(room.roundSuccessMembers) });
    });

    socket.on('submitPickEarly', (roomId, imageData) => {
        const room = rooms[roomId]; if (!room) return;
        room.currentPicks[socket.id] = imageData;
        io.to(roomId).emit('playerSubmitted', socket.id);

        if (room.phase === 'drafting') {
            const expectedCount = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).length;
            const submittedCount = Object.keys(room.currentPicks).length;
            if (submittedCount >= expectedCount) {
                room.phase = 'revealing'; 
                const picksForHost = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).map(p => ({ id: p.id, name: p.name, image: room.currentPicks[p.id] || null }));
                io.to(roomId).emit('startWhiteboardReveal', picksForHost);
            }
        }
    });

    socket.on('forceJudgment', (roomId) => {
        const room = rooms[roomId]; if (!room) return;
        if (room.phase === 'drafting') {
            room.phase = 'revealing';
            const picksForHost = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).map(p => ({ id: p.id, name: p.name, image: room.currentPicks[p.id] || null }));
            io.to(roomId).emit('startWhiteboardReveal', picksForHost);
        }
    });

    socket.on('submitJudgment', (roomId, judgments) => {
        const room = rooms[roomId]; if (!room) return;
        room.phase = 'judging';
        let pickCounts = {};
        const activePlayers = room.players.filter(p => !room.roundSuccessMembers.has(p.id));

        activePlayers.forEach(p => {
            let pickText = judgments[p.id] || "未入力・無効";
            if (!pickCounts[pickText]) pickCounts[pickText] = [];
            pickCounts[pickText].push({ id: p.id, name: p.name });
        });

        let rouletteSequence = []; 
        let missPrefix = "外れ".repeat(room.renominationCount);
        let statusText = missPrefix ? `（${missPrefix}）` : "";

        for (let pickText in pickCounts) {
            let selectors = pickCounts[pickText];
            let displayPickText = pickText + statusText; 

            if (selectors.length === 1) {
                let s = selectors[0];
                room.roundResultsList[s.id] = { playerName: s.name, pick: pickText, status: 'success' };
                room.roundSuccessMembers.add(s.id);
                room.finalDraftLog[s.name].push(displayPickText);
            } else {
                let winnerIndex = Math.floor(Math.random() * selectors.length);
                let winner = selectors[winnerIndex];
                
                rouletteSequence.push({ pick: pickText, players: selectors.map(s => ({ name: s.name })), winnerName: winner.name });
                
                selectors.forEach((s, index) => {
                    let isWinner = (index === winnerIndex);
                    room.roundResultsList[s.id] = { playerName: s.name, pick: pickText, status: isWinner ? 'success' : 'lost', isDuplicate: true };
                    if (isWinner) { 
                        room.roundSuccessMembers.add(s.id); 
                        room.finalDraftLog[s.name].push(displayPickText); 
                    }
                });
            }
        }

        const allDone = (room.roundSuccessMembers.size === room.players.length);
        const fullResultsArray = Object.values(room.roundResultsList); 
        io.to(roomId).emit('showRoundResults', { roulettes: rouletteSequence, results: fullResultsArray, allDone: allDone });
    });

    socket.on('requestFinalResults', (roomId) => {
        if (rooms[roomId]) io.to(roomId).emit('finalSummary', rooms[roomId].finalDraftLog);
    });

    socket.on('requestCurrentHistory', (roomId) => {
        if (rooms[roomId]) socket.emit('currentHistoryData', rooms[roomId].finalDraftLog);
    });

    socket.on('sendOoh', (roomId) => {
        io.to(roomId).emit('playOohSound');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`サーバー起動: ポート${PORT}`); });
