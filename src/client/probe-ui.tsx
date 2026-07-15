// Panel de diagnóstico en pantalla para la sonda de módulos (V13G).
// Usa react-ecs UI — canal validado en móvil (el letrero de V12 se veía),
// a diferencia de TextShape que el explorador Godot móvil no renderiza.
import { ReactEcsRenderer, UiEntity, Label, ReactEcs } from '@dcl/sdk/react-ecs'

let probeText = 'sonda arrancando...'

export function setProbeText(text: string): void {
  probeText = text
}

export function initProbeUi(): void {
  ReactEcsRenderer.setUiRenderer(() => (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: 80, left: 20 },
        width: 600,
        height: 500,
        flexDirection: 'column'
      }}
      uiBackground={{ color: { r: 0, g: 0, b: 0, a: 0.75 } }}
    >
      <Label
        value={probeText}
        fontSize={14}
        color={{ r: 0.4, g: 1, b: 0.6, a: 1 }}
        uiTransform={{ width: '100%', height: '100%' }}
        textAlign='top-left'
      />
    </UiEntity>
  ))
}
