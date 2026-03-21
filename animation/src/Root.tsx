import React from "react"
import { Composition } from "remotion"
import { AWNDemo, TOTAL_FRAMES } from "./AWNDemo"

export const Root: React.FC = () => (
  <Composition
    id="AWNDemo"
    component={AWNDemo}
    durationInFrames={TOTAL_FRAMES}
    fps={30}
    width={1920}
    height={1080}
  />
)
