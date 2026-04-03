const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// publicフォルダを作って ooh.mp3 などを入れた時に読み込めるようにする設定
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

    const expectedCount = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).length;
    const submittedCount = Object.keys(room.currentPicks).filter(id => room.players.find(p => p.id === id)).length;

    if (expectedCount > 0 && submittedCount >= expectedCount) {
        const picksForHost = room.players
            .filter(p => !room.roundSuccessMembers.has(p.id))
            .map(p => ({ id: p.id, name: p.name, image: room.currentPicks[p.id] || null }));
        io.to(targetRoomId).emit('startWhiteboardReveal', picksForHost);
    }
}

io.on('connection', (socket) => {
    // 部屋への入室処理
    socket.on('joinRoomRequest', (password) => {
        if (!rooms[password]) { 
            rooms[password] = { 
                hostId: socket.id, players: [], finalDraftLog: {}, 
                roundSuccessMembers: new Set(), currentPicks: {}, 
                roundResultsList: {}, 
                theme: "", maxRounds: 1 
            }; 
        }
        if (rooms[password].players.length >= 10) { socket.emit('roomError', 'この部屋は満員（最大10人）です！'); return; }
        socket.join(password);
        socket.emit('roomJoinedOk', password);
    });

    socket.on('join', (roomId, name) => {
        const room = rooms[roomId]; if (!room) return;
        room.players.push({ id: socket.id, name: name });
        if (!room.finalDraftLog[name]) room.finalDraftLog[name] = [];
        io.to(roomId).emit('updatePlayers', room.players);
        if (socket.id === room.hostId) socket.emit('youAreHost'); else socket.emit('youAreNotHost');
    });

    socket.on('leaveRoom', () => { handlePlayerLeave(socket); for (const room of socket.rooms) { if (room !== socket.id) socket.leave(room); } });
    socket.on('disconnect', () => { handlePlayerLeave(socket); });

    // 会議進行
    socket.on('startMeeting', (roomId, settings) => {
        const room = rooms[roomId]; if (!room) return;
        room.theme = settings.theme; room.maxRounds = settings.rounds;
        room.players.sort(() => Math.random() - 0.5);
        io.to(roomId).emit('meetingStarted', { players: room.players, theme: room.theme, rounds: room.maxRounds });
    });

    socket.on('startRound', (roomId, roundNumber, seconds, isRenomination = false) => {
        const room = rooms[roomId]; if (!room) return;
        room.currentPicks = {}; 
        if (!isRenomination) {
            room.roundSuccessMembers.clear();
            room.roundResultsList = {}; 
        }
        io.to(roomId).emit('startTimer', { seconds: seconds, currentRound: roundNumber, successMembers: Array.from(room.roundSuccessMembers) });
    });

    socket.on('submitPickEarly', (roomId, imageData) => {
        const room = rooms[roomId]; if (!room) return;
        room.currentPicks[socket.id] = imageData;
        io.to(roomId).emit('playerSubmitted', socket.id);

        const expectedCount = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).length;
        const submittedCount = Object.keys(room.currentPicks).length;
        if (submittedCount >= expectedCount) {
            const picksForHost = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).map(p => ({ id: p.id, name: p.name, image: room.currentPicks[p.id] || null }));
            io.to(roomId).emit('startWhiteboardReveal', picksForHost);
        }
    });

    socket.on('forceJudgment', (roomId) => {
        const room = rooms[roomId]; if (!room) return;
        const picksForHost = room.players.filter(p => !room.roundSuccessMembers.has(p.id)).map(p => ({ id: p.id, name: p.name, image: room.currentPicks[p.id] || null }));
        io.to(roomId).emit('startWhiteboardReveal', picksForHost);
    });

    // 司会者の判定と競合処理
    socket.on('submitJudgment', (roomId, judgments) => {
        const room = rooms[roomId]; if (!room) return;
        let pickCounts = {};
        const activePlayers = room.players.filter(p => !room.roundSuccessMembers.has(p.id));

        activePlayers.forEach(p => {
            let pickText = judgments[p.id] || "未入力・無効";
            if (!pickCounts[pickText]) pickCounts[pickText] = [];
            pickCounts[pickText].push({ id: p.id, name: p.name });
        });

        let rouletteSequence = []; 

        for (let pickText in pickCounts) {
            let selectors = pickCounts[pickText];

            if (selectors.length === 1) {
                let s = selectors[0];
                room.roundResultsList[s.id] = { playerName: s.name, pick: pickText, status: 'success' };
                room.roundSuccessMembers.add(s.id);
                room.finalDraftLog[s.name].push(pickText);
            } else {
                let winnerIndex = Math.floor(Math.random() * selectors.length);
                let winner = selectors[winnerIndex];
                
                rouletteSequence.push({ pick: pickText, players: selectors.map(s => ({ name: s.name })), winnerName: winner.name });
                
                selectors.forEach((s, index) => {
                    let isWinner = (index === winnerIndex);
                    room.roundResultsList[s.id] = { playerName: s.name, pick: pickText, status: isWinner ? 'success' : 'lost', isDuplicate: true };
                    if (isWinner) { room.roundSuccessMembers.add(s.id); room.finalDraftLog[s.name].push(pickText); }
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

    // 「おぉ〜」ボタンの合図を全員に送る
    socket.on('sendOoh', (roomId) => {
        io.to(roomId).emit('playOohSound');
    });
});

// クラウドサーバー(Render/Glitch)対応ポート設定
const PORT = process.env.PORT || 3