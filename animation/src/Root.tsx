import React from "react"
import { Composition } from "remotion"
import { DAPDemo, TOTAL_FRAMES } from "./DAPDemo"

export const Root: React.FC = () => (
  <Composition
    id="DAPDemo"
    component={DAPDemo}
    durationInFrames={TOTAL_FRAMES}
    fps={30}
    width={1920}
    height={1080}
  />
)
