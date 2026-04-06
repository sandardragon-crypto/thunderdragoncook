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

function checkMvtStatus(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const voteCount = Object.keys(room.votes).length;
    const requiredVotes = Math.ceil(room.players.length / 2);
    
    if (voteCount >= requiredVotes && voteCount > 0) {
        io.to(roomId).emit('mvtReady');
    }
}

function handlePlayerLeave(socket) {
    let targetRoomId = null;
    for (const roomId in rooms) {
        if (rooms[roomId].players.find(p => p.id === socket.id)) { targetRoomId = roomId; break; }
    }
    if (!targetRoomId) return;
    const room = rooms[targetRoomId];
    
    room.players = room.players.filter(p => p.id !== socket.id);
    room.roundSuccessMembers.delete(socket.id);
    delete room.currentPicks[socket.id];
    delete room.roundResultsList[socket.id];
    if (room.votes[socket.id]) { delete room.votes[socket.id]; }

    if (room.players.length === 0) { delete rooms[targetRoomId]; return; }
    if (room.hostId === socket.id) { room.hostId = room.players[0].id; io.to(room.hostId).emit('youAreHost'); }
    
    io.to(targetRoomId).emit('updatePlayers', room.players.map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId })));

    if (room.phase === 'drafting') {
        const expectedCount = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).length;
        const submittedCount = Object.keys(room.currentPicks).filter(id => room.players.find(p => p.id === id)).length;

        if (expectedCount === 0 || (expectedCount > 0 && submittedCount >= expectedCount)) {
            io.to(targetRoomId).emit('allPlayersSubmitted');
        }
    }
    checkMvtStatus(targetRoomId);
}

io.on('connection', (socket) => {
    socket.on('joinRoomRequest', (password) => {
        if (!rooms[password]) { 
            rooms[password] = { 
                hostId: socket.id, players: [], finalDraftLog: {}, 
                roundSuccessMembers: new Set(), currentPicks: {}, 
                roundResultsList: {}, theme: "", maxRounds: 1,
                phase: 'waiting', renominationCount: 0, votes: {}, textOnly: false
            }; 
        }
        socket.join(password);
        socket.emit('roomJoinedOk', password);
    });

    socket.on('join', (roomId, name) => {
        const room = rooms[roomId]; if (!room) return;

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
        
        io.to(roomId).emit('updatePlayers', room.players.map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId })));
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
            if (room.votes[targetId]) delete room.votes[targetId];
            io.to(roomId).emit('updatePlayers', room.players.map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId })));
            checkMvtStatus(roomId);
        }
    });

    socket.on('startMeeting', (roomId, settings) => {
        const room = rooms[roomId]; if (!room) return;
        room.theme = settings.theme; room.maxRounds = settings.rounds; room.textOnly = settings.textOnly;
        room.votes = {};
        room.players.sort(() => Math.random() - 0.5);
        io.to(roomId).emit('meetingStarted', { players: room.players, theme: room.theme, rounds: room.maxRounds, textOnly: room.textOnly });
    });

    socket.on('startRound', (roomId, roundNumber, seconds, isRenomination = false) => {
        const room = rooms[roomId]; if (!room) return;
        
        // ★真のバグ修正：再指名すべき人がすでに全員退出していた場合、ファントムラウンドをスキップする
        if (isRenomination) {
            const expectedCount = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).length;
            if (expectedCount === 0) {
                const fullResultsArray = Object.values(room.roundResultsList); 
                io.to(roomId).emit('showRoundResults', { roulettes: [], results: fullResultsArray, allDone: true });
                return; // ここで止めて、画面を即座に「次の巡へ進む」状態にする
            }
            room.renominationCount++;
        } else {
            room.roundSuccessMembers.clear(); 
            room.roundResultsList = {}; 
            room.renominationCount = 0; 
        }
        
        room.phase = 'drafting'; room.currentPicks = {}; 
        io.to(roomId).emit('startTimer', { seconds: seconds, currentRound: roundNumber, successMembers: Array.from(room.roundSuccessMembers) });
    });

    socket.on('submitPickEarly', (roomId, imageData) => {
        const room = rooms[roomId]; if (!room) return;
        room.currentPicks[socket.id] = imageData;
        io.to(roomId).emit('playerSubmitted', socket.id);
        if (room.phase === 'drafting') {
            const expectedCount = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).length;
            const submittedCount = Object.keys(room.currentPicks).length;
            if (submittedCount >= expectedCount) { io.to(roomId).emit('allPlayersSubmitted'); }
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
                    if (isWinner) { room.roundSuccessMembers.add(s.id); room.finalDraftLog[s.name].push(displayPickText); }
                });
            }
        }

        const allDone = room.players.length > 0 && room.players.every(p => room.roundSuccessMembers.has(p.id));
        const fullResultsArray = Object.values(room.roundResultsList); 
        io.to(roomId).emit('showRoundResults', { roulettes: rouletteSequence, results: fullResultsArray, allDone: allDone });
    });

    socket.on('requestFinalResults', (roomId) => { if (rooms[roomId]) io.to(roomId).emit('finalSummary', rooms[roomId].finalDraftLog); });
    socket.on('requestCurrentHistory', (roomId) => { if (rooms[roomId]) socket.emit('currentHistoryData', rooms[roomId].finalDraftLog); });
    socket.on('sendOoh', (roomId) => { io.to(roomId).emit('playOohSound'); });

    socket.on('submitVote', (roomId, targetName) => {
        const room = rooms[roomId]; if (!room) return;
        room.votes[socket.id] = targetName;
        checkMvtStatus(roomId);
    });

    socket.on('triggerMVT', (roomId) => {
        const room = rooms[roomId]; if (!room) return;
        let voteCounts = {};
        for (let vid in room.votes) { let vName = room.votes[vid]; voteCounts[vName] = (voteCounts[vName] || 0) + 1; }

        let maxVotes = 0; let winners = [];
        for (let name in voteCounts) {
            if (voteCounts[name] > maxVotes) { maxVotes = voteCounts[name]; winners = [name]; } 
            else if (voteCounts[name] === maxVotes) { winners.push(name); }
        }

        let finalWinner = "";
        if (winners.length > 0) { finalWinner = winners[Math.floor(Math.random() * winners.length)]; } 
        else { finalWinner = room.players[Math.floor(Math.random() * room.players.length)].name; }

        io.to(roomId).emit('showMVTRoulette', { winner: finalWinner, players: room.players });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`サーバー起動: ポート${PORT}`); });
