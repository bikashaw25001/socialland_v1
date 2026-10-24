import { useEffect, useRef, useState } from 'react'

type GameKind = 'chess' | 'ludo' | 'tic-tac-toe'
type GameSession = {
  board: unknown
  turn: number
  playerIds: string[]
  lastRoll?: number | null
  lastRollBy?: string | null
  status: string
  winner?: string | null
}

type Props = {
  game: GameKind
  session: GameSession
  userId: string
  names: string[]
  selected: number | null
  onSelect: (square: number | null) => void
  onMove: (from: number, to: number) => void
  onPieceMove: (piece: number) => void
  onPlace: (index: number) => void
  onRoll: () => void
  onReady: () => void
}

const ludoRoute: [number, number][] = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 7],
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
  [7, 14], [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9], [9, 8], [10, 8], [11, 8], [12, 8], [13, 8],
  [14, 8], [14, 7], [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6], [8, 5], [8, 4], [8, 3], [8, 2],
  [8, 1], [8, 0], [7, 0], [6, 0]
]
const ludoHomes: [number, number][][] = [
  [[2, 2], [2, 4], [4, 2], [4, 4]], [[2, 10], [2, 12], [4, 10], [4, 12]],
  [[10, 10], [10, 12], [12, 10], [12, 12]], [[10, 2], [10, 4], [12, 2], [12, 4]]
]
const ludoColors = ['green', 'yellow', 'blue', 'red']
const ludoSafeSquares = new Set([0, 8, 13, 21, 26, 34, 39, 47])
const dicePips: Record<number, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }

function expandChessBoard(value: unknown): string[] {
  const fen = String(value || '')
  const cells = fen.split('/').flatMap(rank => [...rank].flatMap(char => /^[1-8]$/.test(char) ? Array(Number(char)).fill('') : char))
  return cells.length === 64 ? cells : [...'rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR']
}

function ludoPieceCell(player: number, progress: number, piece: number): [number, number] {
  if (progress <= 0) return ludoHomes[player][piece]
  if (progress >= 57) return [7, 7]
  if (progress >= 52) {
    const lane: [number, number][][] = [
      Array.from({ length: 6 }, (_, i) => [7, i + 1]), Array.from({ length: 6 }, (_, i) => [i + 1, 7]),
      Array.from({ length: 6 }, (_, i) => [7, 13 - i]), Array.from({ length: 6 }, (_, i) => [13 - i, 7])
    ]
    return lane[player][progress - 52]
  }
  const [row, col] = ludoRoute[([0, 13, 26, 39][player] + progress - 1) % 52]
  return [row, col]
}

function ludoCellClass(row: number, col: number): string {
  if (row === 7 && col === 7) return 'home-center'
  if (row === 7 && col >= 1 && col <= 6) return 'lane-green'
  if (col === 7 && row >= 1 && row <= 6) return 'lane-yellow'
  if (row === 7 && col >= 8 && col <= 13) return 'lane-blue'
  if (col === 7 && row >= 8 && row <= 13) return 'lane-red'
  if ((row === 6 || row === 8) && col >= 1 && col <= 5 || (row === 6 || row === 8) && col >= 9 && col <= 13) return 'ludo-track'
  if ((col === 6 || col === 8) && row >= 1 && row <= 5 || (col === 6 || col === 8) && row >= 9 && row <= 13) return 'ludo-track'
  return 'ludo-empty'
}

function LudoBoard({ session, userId, names, onPieceMove, onRoll }: Pick<Props, 'session' | 'userId' | 'names' | 'onPieceMove' | 'onRoll'>) {
  const [rollingFace, setRollingFace] = useState<number | null>(null)
  const board = Array.isArray(session.board) ? session.board as number[][] : []
  const playerIndex = session.playerIds.indexOf(userId)
  const isMyTurn = session.status === 'started' && session.playerIds[session.turn] === userId
  const piecesAt = new Map<string, { player: number; piece: number; progress: number }[]>()
  for (let player = 0; player < Math.min(4, session.playerIds.length); player++) {
    for (let piece = 0; piece < 4; piece++) {
      const progress = board[player]?.[piece] || 0
      if (progress === 0) continue
      const [row, col] = ludoPieceCell(player, progress, piece)
      const key = `${row}-${col}`
      piecesAt.set(key, [...(piecesAt.get(key) || []), { player, piece, progress }])
    }
  }

  useEffect(() => {
    if (session.lastRollBy !== userId || !session.lastRoll) { setRollingFace(null); return }
    const interval = window.setInterval(() => setRollingFace(1 + Math.floor(Math.random() * 6)), 75)
    const timeout = window.setTimeout(() => { setRollingFace(null); window.clearInterval(interval) }, 850)
    return () => { window.clearInterval(interval); window.clearTimeout(timeout) }
  }, [session.lastRoll, session.lastRollBy, userId])

  const roll = session.lastRoll || 1
  const visibleRoll = rollingFace ?? roll
  const canMovePiece = (progress: number) => isMyTurn && playerIndex >= 0 && session.lastRollBy === userId && !!session.lastRoll && (progress === 0 ? session.lastRoll === 6 : progress < 57 && progress + session.lastRoll <= 57)
  const homePlayers = [
    { player: 0, corner: 'top-left' }, { player: 1, corner: 'top-right' },
    { player: 3, corner: 'bottom-left' }, { player: 2, corner: 'bottom-right' }
  ]

  return <div className="game2d-ludo-wrap">
    <div className="game2d-ludo-board" role="grid" aria-label="Ludo board">
      {Array.from({ length: 15 * 15 }, (_, index) => {
        const row = Math.floor(index / 15), col = index % 15
        const pieces = piecesAt.get(`${row}-${col}`) || []
        const safeIndex = ludoRoute.findIndex(([safeRow, safeCol], routeIndex) => safeRow === row && safeCol === col && ludoSafeSquares.has(routeIndex))
        return <div key={index} role="gridcell" className={`game2d-ludo-cell ${ludoCellClass(row, col)} ${safeIndex >= 0 ? 'ludo-safe' : ''}`}>
          {safeIndex >= 0 && <span className="game2d-ludo-star" aria-hidden="true">&#9733;</span>}
          {pieces.map(item => <button type="button" key={`${item.player}-${item.piece}`} disabled={!canMovePiece(item.progress) || item.player !== playerIndex} className={`game2d-ludo-token ${ludoColors[item.player]} on-track`} aria-label={`${names[item.player] || `Player ${item.player + 1}`} piece ${item.piece + 1}${canMovePiece(item.progress) && item.player === playerIndex ? ', move this piece' : ''}`} onClick={() => onPieceMove(item.piece)}><i/></button>)}
        </div>
      })}
      <div className="game2d-ludo-finish" aria-hidden="true"/>
      <div className="game2d-ludo-homes" aria-label="Player home areas">
        {homePlayers.map(({ player, corner }) => (
          <div key={player} className={`game2d-ludo-home ${ludoColors[player]} ${corner}`}>
            <div className="game2d-ludo-home-pad">
              {Array.from({ length: 4 }, (_, piece) => {
                const progress = board[player]?.[piece] || 0
                const enabled = player === playerIndex && canMovePiece(progress)
                return <div className="game2d-ludo-home-slot" key={piece}>
                  {progress === 0 && <button type="button" disabled={!enabled} className={`game2d-ludo-token ${ludoColors[player]} at-home`} aria-label={`${names[player] || `Player ${player + 1}`} piece ${piece + 1}${enabled ? ', move out of home' : ''}`} onClick={() => onPieceMove(piece)}><i/></button>}
                </div>
              })}
            </div>
            <small className="game2d-ludo-home-name">{names[player] || 'Open seat'}</small>
          </div>
        ))}
      </div>
    </div>
    <div className="game2d-ludo-footer"><div className="game2d-ludo-players">{session.playerIds.map((id, index) => <span key={id} className={`game2d-player-chip ${ludoColors[index]}`}><i/>{names[index] || `Player ${index + 1}`}</span>)}</div><div className="game2d-dice-area"><span>{session.lastRollBy ? session.lastRollBy === userId ? `You rolled ${session.lastRoll}` : `${names[session.playerIds.indexOf(session.lastRollBy)] || 'Player'} rolled ${session.lastRoll}` : isMyTurn ? 'Your turn - roll the dice' : `${names[session.turn] || 'Player'}'s turn`}</span><button type="button" className={`game2d-dice-button ${rollingFace !== null ? 'rolling' : ''}`} disabled={!isMyTurn || !!session.lastRollBy} onClick={onRoll} aria-label={session.lastRollBy ? `Dice result ${session.lastRoll}` : 'Roll the dice'}>{session.lastRollBy ? <span className="game2d-die-face" aria-hidden="true">{Array.from({ length: 9 }, (_, pip) => <i key={pip} className={dicePips[visibleRoll].includes(pip) ? 'visible' : ''}/>)}</span> : <span className="game2d-die-roll">Roll <small>&#9860;</small></span>}</button></div>
  </div>
    </div>
}

export default function GameBoard2D({ game, session, userId, names, selected, onSelect, onMove, onPieceMove, onPlace, onRoll, onReady }: Props) {
  const ready = useRef(false)
  useEffect(() => { if (!ready.current) { ready.current = true; onReady() } }, [onReady])
  const currentPlayerIndex = session.turn
  const currentPlayerName = names[currentPlayerIndex] || 'Player'
  const isMyTurn = session.status === 'started' && session.playerIds[currentPlayerIndex] === userId

  if (game === 'ludo') return <section className="game2d-shell game2d-ludo-shell" aria-label="Ludo game board"><header className="game2d-status"><span className={isMyTurn ? 'your-turn' : ''}/><div><b>{session.status === 'ended' ? session.winner ? `${names[session.playerIds.indexOf(session.winner)] || 'Player'} wins` : 'Game ended' : isMyTurn ? 'Your turn' : `${currentPlayerName}'s turn`}</b><small>Move your pieces around the board and get all four home.</small></div></header><LudoBoard session={session} userId={userId} names={names} onPieceMove={onPieceMove} onRoll={onRoll}/></section>

  if (game === 'tic-tac-toe') {
    const cells = Array.isArray(session.board) ? session.board as (string | null)[] : Array(9).fill(null)
    return <section className="game2d-shell game2d-small-board" aria-label="Tic Tac Toe game board"><header className="game2d-status"><span className={isMyTurn ? 'your-turn' : ''}/><div><b>{session.status === 'ended' ? session.winner ? `${names[session.playerIds.indexOf(session.winner)] || 'Player'} wins` : 'Draw game' : isMyTurn ? 'Your turn' : `${currentPlayerName}'s turn`}</b><small>{isMyTurn ? `Place ${session.turn === 0 ? 'X' : 'O'} in an empty square.` : 'Waiting for the other player.'}</small></div></header><div className="game2d-tic-board" role="grid" aria-label="Tic Tac Toe board">{cells.map((cell, index) => <button type="button" role="gridcell" key={index} disabled={!isMyTurn || !!cell} className={`${cell ? `mark-${cell.toLowerCase()}` : ''}`} aria-label={`Square ${index + 1}${cell ? `, ${cell}` : ', empty'}`} onClick={() => onPlace(index)}>{cell}</button>)}</div><footer className="game2d-legend"><span><i className="mark-x">X</i>You</span><span><i className="mark-o">O</i>{names[1] || 'Friend'}</span></footer></section>
  }

  const cells = expandChessBoard(session.board)
  const flipped = session.playerIds.indexOf(userId) === 1
  const mySide = session.playerIds.indexOf(userId) === 0 ? 'white' : 'black'
  const symbols: Record<string, string> = { K: String.fromCodePoint(0x2654), Q: String.fromCodePoint(0x2655), R: String.fromCodePoint(0x2656), B: String.fromCodePoint(0x2657), N: String.fromCodePoint(0x2658), P: String.fromCodePoint(0x2659), k: String.fromCodePoint(0x265a), q: String.fromCodePoint(0x265b), r: String.fromCodePoint(0x265c), b: String.fromCodePoint(0x265d), n: String.fromCodePoint(0x265e), p: String.fromCodePoint(0x265f) }
  return <section className="game2d-shell game2d-chess-shell" aria-label="Chess game board"><header className="game2d-status"><span className={isMyTurn ? 'your-turn' : ''}/><div><b>{session.status === 'ended' ? session.winner ? `${names[session.playerIds.indexOf(session.winner)] || 'Player'} wins` : 'Game ended' : isMyTurn ? 'Your turn' : `${currentPlayerName}'s turn`}</b><small>{isMyTurn ? `You are playing ${mySide}. Select one of your pieces, then a destination.` : 'Waiting for the other player.'}</small></div></header><div className="game2d-chess-board" role="grid" aria-label="Chess board">{Array.from({ length: 64 }, (_, visualIndex) => {
    const index = flipped ? 63 - visualIndex : visualIndex
    const row = Math.floor(visualIndex / 8), col = visualIndex % 8
    const piece = cells[index]
    const isMine = piece && (mySide === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase())
    return <button type="button" role="gridcell" key={index} disabled={!isMyTurn} className={`${(row + col) % 2 ? 'dark-square' : 'light-square'} ${selected === index ? 'selected-square' : ''} ${piece && isMine ? 'own-piece' : ''}`} aria-label={`${piece ? (isMine ? 'Your' : 'Opponent') + ' ' + piece : 'Empty'} square ${index + 1}`} onClick={() => {
      if (selected === null) { if (isMine) onSelect(index); return }
      if (isMine) { onSelect(index); return }
      onMove(selected, index)
    }}>{piece ? <span className={`chess-piece ${piece === piece.toUpperCase() ? 'chess-piece-white' : 'chess-piece-black'}`}>{symbols[piece] || piece}</span> : null}</button>
  })}</div><footer className="game2d-legend"><span><i className="chess-white">{String.fromCodePoint(0x2654)}</i>{names[0] || 'White'}</span><span><i className="chess-black">{String.fromCodePoint(0x265a)}</i>{names[1] || 'Black'}</span></footer></section>
}
