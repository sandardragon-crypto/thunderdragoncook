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
    
    // ★バグ修正5: 抜けた人を成功者リストや提出リストからも確実に削除する（進行不能バグの根本原因）
    room.players = room.players.filter(p => p.id !== socket.id);
    room.roundSuccessMembers.delete(socket.id);
    delete room.currentPicks[socket.id];
    delete room.roundResultsList[socket.id];

    if (room.players.length === 0) { delete rooms[targetRoomId]; return; }
    if (room.hostId === socket.id) { room.hostId = room.players[0].id; io.to(room.hostId).emit('youAreHost'); }
    io.to(targetRoomId).emit('updatePlayers', room.players);

    if (room.phase === 'drafting') {
        const expectedCount = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).length;
        const submittedCount = Object.keys(room.currentPicks).filter(id => room.players.find(p => p.id === id)).length;

        if (expectedCount > 0 && submittedCount >= expectedCount) {
            // ★バグ修正2: 勝手に画面を飛ばさず、ホストに「全員完了」の合図だけを送る
            io.to(targetRoomId).emit('allPlayersSubmitted');
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
        socket.join(password);
        socket.emit('roomJoinedOk', password);
    });

    socket.on('join', (roomId, name) => {
        const room = rooms[roomId]; if (!room) return;

        // ★バグ修正1&6: 定員オーバーや、既に進行中の部屋には絶対に入れないように弾く
        if (room.players.length >= 10) { socket.emit('roomError', 'この部屋は満員（最大10人）です！'); return; }
        if (room.phase !== 'waiting') { socket.emit('roomError', '既にドラフト会議が進行中のため入室できません！'); return; }

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

    socket.on('kickPlayer', (roomId, targetId) => {
        const room = rooms[roomId]; if (!room) return;
        if (socket.id !== room.hostId) return; 
        
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) { targetSocket.disconnect(true); } 
        else {
            room.players = room.players.filter(p => p.id !== targetId);
            room.roundSuccessMembers.delete(targetId);
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
                // ★バグ修正2: 勝手に飛ばさず、ホストにボタン解禁の合図を出す
                io.to(roomId).emit('allPlayersSubmitted');
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

        let rouletteSequence = []; 
        let missPrefix = "外れ".repeat(room.renominationCount);
        let statusText = missPrefix ? `（${missPrefix}）` : "";

        activePlayers.forEach(p => {
            let pickText = judgments[p.id] || "未入力";
            
            // ★バグ修正3: 「未入力」の場合は即座に失敗扱い（外れ再指名）に回す
            if (pickText === "未入力") {
                room.roundResultsList[p.id] = { playerName: p.name, pick: "未入力（時間切れ/エラー）", status: 'lost', isDuplicate: false };
                room.finalDraftLog[p.name].push("未入力" + statusText);
            } else {
                if (!pickCounts[pickText]) pickCounts[pickText] = [];
                pickCounts[pickText].push({ id: p.id, name: p.name });
            }
        });

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

        // ★バグ修正5: 進行不能ループの解消。現在いるプレイヤーだけで正確に計算する
        const allDone = room.players.length > 0 && room.players.every(p => room.roundSuccessMembers.has(p.id));
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
