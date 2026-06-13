import { engine, Schemas } from '@dcl/sdk/ecs'
import { MessageBus } from '@dcl/sdk/message-bus'

//  Authoritative game state 
// The server owns this component. Clients only read it. Every meaningful
// state transition increments `stateSeq` so a client can tell whether CRDT
// has gone stale.
export const RoundState = engine.defineComponent('dbc:RoundState', {
  phase:           Schemas.String,
  roundNumber:     Schemas.Int,
  templateId:      Schemas.String,
  partsAttached:   Schemas.Int,
  partsRequired:   Schemas.Int,
  occupiedMask:    Schemas.Int,
  performanceType: Schemas.String,
  builders:        Schemas.String,
  stateSeq:        Schemas.Int
})

export const GameTimer = engine.defineComponent('dbc:GameTimer', {
  secondsLeft: Schemas.Int
})

//  Placement requests 
// Client → server. Created on each click, synced via CRDT, processed once
// and removed by the server. requestId dedupes against re-deliveries.
export const AttachRequest = engine.defineComponent('dbc:AttachRequest', {
  requestId:   Schemas.String,
  playerId:    Schemas.String,
  displayName: Schemas.String,
  slotId:      Schemas.String,
  partType:    Schemas.String,
  templateId:  Schemas.String,
  roundNumber: Schemas.Int
})

//  UX hint MessageBus 
// Used ONLY for transient feedback (sounds, popups, wrong-piece flashes).
// Never used as the primary source of phase/template/round/occupancy.
export type UxEvent = 'wrongPart' | 'attachRejected'

const bus = new MessageBus()

export const ux = {
  emit(event: UxEvent, payload: Record<string, unknown>): void {
    bus.emit(event, payload)
  },
  on<T = any>(event: UxEvent, handler: (payload: T, sender: string) => void): void {
    bus.on(event, (payload, sender) => handler(payload as T, sender))
  }
}
