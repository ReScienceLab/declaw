import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"

const source = fs.readFileSync(
  new URL("../dist/yggdrasil.js", import.meta.url),
  "utf8"
)

describe("yggdrasil daemon detection", () => {
  it("defines WELL_KNOWN_TCP_ENDPOINTS with 127.0.0.1:9001", () => {
    assert.ok(
      source.includes("tcp://127.0.0.1:9001"),
      "should have TCP admin endpoint as first detection candidate"
    )
  })

  it("exports detectExternalYggdrasil", () => {
    assert.ok(
      source.includes("exports.detectExternalYggdrasil"),
      "detectExternalYggdrasil should be exported"
    )
  })

  it("tries TCP endpoints before UNIX sockets", () => {
    const fnBody = source.slice(source.indexOf("function detectExternalYggdrasil"))
    const tcpUse = fnBody.indexOf("WELL_KNOWN_TCP_ENDPOINTS")
    const sockUse = fnBody.indexOf("WELL_KNOWN_SOCKETS")
    assert.ok(tcpUse < sockUse, "TCP endpoints should be checked before UNIX sockets")
  })

  it("caches detectedEndpoint on successful detection", () => {
    assert.ok(
      source.includes("detectedEndpoint = ep"),
      "should cache TCP endpoint on successful detection"
    )
    assert.ok(
      source.includes("detectedEndpoint = endpoint"),
      "should cache UNIX socket endpoint on successful detection"
    )
  })

  it("tryYggdrasilctl skips -endpoint flag when endpoint is empty", () => {
    const fnBody = source.slice(source.indexOf("function tryYggdrasilctl"))
    assert.ok(
      fnBody.includes("yggdrasilctl -json getSelf"),
      "bare fallback should not include -endpoint flag"
    )
  })

  it("yggctl helper uses detectedEndpoint", () => {
    assert.ok(
      source.includes("function yggctl"),
      "should have a yggctl helper function"
    )
    const fnBody = source.slice(source.indexOf("function yggctl"))
    assert.ok(
      fnBody.includes("detectedEndpoint"),
      "yggctl should use detectedEndpoint"
    )
  })

  it("ensurePublicPeers uses yggctl helper", () => {
    const fnBody = source.slice(source.indexOf("function ensurePublicPeers"))
    assert.ok(
      fnBody.includes("yggctl("),
      "ensurePublicPeers should use yggctl helper for consistent endpoint usage"
    )
  })

  it("getYggdrasilNetworkInfo uses yggctl helper", () => {
    const fnBody = source.slice(source.indexOf("function getYggdrasilNetworkInfo"))
    assert.ok(
      fnBody.includes("yggctl("),
      "getYggdrasilNetworkInfo should use yggctl helper for consistent endpoint usage"
    )
  })

  it("generateConfig uses TCP admin endpoint", () => {
    const genFn = source.slice(source.indexOf("function generateConfig"))
    assert.ok(
      genFn.includes("WELL_KNOWN_TCP_ENDPOINTS"),
      "generateConfig should use TCP admin endpoint by default"
    )
  })

  it("logs actionable message on socket permission denied", () => {
    assert.ok(
      source.includes("setup-yggdrasil.sh"),
      "should suggest setup script when socket access fails"
    )
  })
})
