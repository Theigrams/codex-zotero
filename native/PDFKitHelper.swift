// Long-lived PDFKit helper. One JSON object per line on stdin, one reply per line on stdout.
// Coordinates are PDF points with a top-left origin relative to the page crop box.
//
//   {"id":1,"op":"open","path":"/x.pdf"}                        -> doc handle, page sizes
//   {"id":2,"op":"render","doc":"d1","page":1,"out":"/c/s.png",
//    "region":[x,y,w,h], "scale":3.2, "full":[W,H], "tile":[tx,ty,tw,th], "weight":"graygamma:1.3"}
//       region: part of the page in points (default: whole crop box);
//       full:   size in pixels of the whole region at `scale` (the caller's layout decides rounding);
//       tile:   the pixel rectangle of that bitmap to draw (default: all of it).
//   {"id":3,"op":"chars","doc":"d1","page":1}                   -> page text + one rect per UTF-16 unit
//   {"id":4,"op":"links","doc":"d1","page":1}
//   {"id":5,"op":"content_bounds","doc":"d1","page":1}
//   {"id":7,"op":"outline","doc":"d1"}                          -> the PDF's bookmarks: title, depth, page, y
//   {"id":6,"op":"close","doc":"d1"}
import Foundation
import PDFKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

var documents: [String: PDFDocument] = [:]
var nextDocument = 1

struct Failure: Error { let message: String }

func ms(since start: DispatchTime) -> Double {
  Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
}

func r2(_ v: CGFloat) -> Double { (Double(v) * 100).rounded() / 100 }

func topLeft(_ r: CGRect, in box: CGRect) -> [Double] {
  [r2(r.minX - box.minX), r2(box.maxY - r.maxY), r2(r.width), r2(r.height)]
}

func page(_ req: [String: Any]) throws -> (PDFDocument, PDFPage, CGRect) {
  guard let id = req["doc"] as? String, let doc = documents[id] else { throw Failure(message: "unknown doc") }
  guard let n = req["page"] as? Int, n >= 1, n <= doc.pageCount, let p = doc.page(at: n - 1) else {
    throw Failure(message: "page out of range")
  }
  return (doc, p, p.bounds(for: .cropBox))
}

func doubles(_ value: Any?, count: Int) -> [Double]? {
  guard let a = value as? [Any], a.count == count else { return nil }
  let d = a.compactMap { ($0 as? NSNumber)?.doubleValue }
  return d.count == count && d.allSatisfy({ $0.isFinite }) ? d : nil
}

// c' = c^g for near-neutral pixels only: full effect at chroma <= 16, none at >= 48.
func grayGamma(_ data: UnsafeMutableRawPointer, width: Int, height: Int, bytesPerRow: Int, gamma: Double) {
  let lut = (0...255).map { UInt8((pow(Double($0) / 255, gamma) * 255).rounded()) }
  let px = data.bindMemory(to: UInt8.self, capacity: bytesPerRow * height)
  for y in 0..<height {
    let row = px + y * bytesPerRow
    for x in 0..<width {
      let o = x * 4
      let r = row[o], g = row[o + 1], b = row[o + 2]
      let chroma = Int(max(r, g, b)) - Int(min(r, g, b))
      if chroma >= 48 { continue }
      if chroma <= 16 {
        row[o] = lut[Int(r)]; row[o + 1] = lut[Int(g)]; row[o + 2] = lut[Int(b)]
      } else {
        let w = Double(48 - chroma) / 32
        for c in 0..<3 {
          let p = Double(row[o + c])
          row[o + c] = UInt8((p + (Double(lut[Int(row[o + c])]) - p) * w).rounded())
        }
      }
    }
  }
}

func render(_ req: [String: Any]) throws -> [String: Any] {
  let (_, p, box) = try page(req)
  guard let out = req["out"] as? String, let scale = (req["scale"] as? NSNumber)?.doubleValue, scale > 0, scale <= 12,
        let full = doubles(req["full"], count: 2) else { throw Failure(message: "render needs out, scale and full") }
  let region = doubles(req["region"], count: 4) ?? [0, 0, Double(box.width), Double(box.height)]
  let (fullW, fullH) = (Int(full[0]), Int(full[1]))
  let tile = doubles(req["tile"], count: 4).map { $0.map(Int.init) } ?? [0, 0, fullW, fullH]
  let (tx, ty) = (tile[0], tile[1])
  let (tw, th) = (min(tile[2], fullW - tx), min(tile[3], fullH - ty))
  guard tx >= 0, ty >= 0, tw > 0, th > 0, tw * th <= 40_000_000 else { throw Failure(message: "bad tile") }
  guard let ctx = CGContext(data: nil, width: tw, height: th, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    throw Failure(message: "no context")
  }
  let t0 = DispatchTime.now()
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: tw, height: th))
  // Pixel (tx, ty) from the top-left of the region bitmap becomes the tile's top-left corner;
  // the region's top-left point (box.minX + x, box.maxY - y) lands on that bitmap's top-left.
  ctx.translateBy(x: CGFloat(-tx), y: CGFloat(-(fullH - ty - th)))
  ctx.scaleBy(x: scale, y: scale)
  ctx.translateBy(x: -(box.minX + region[0]), y: -(box.maxY - region[1] - region[3]))
  ctx.setShouldAntialias(true)
  ctx.interpolationQuality = .high
  p.draw(with: .cropBox, to: ctx)
  let drawMs = ms(since: t0)
  let t1 = DispatchTime.now()
  if let weight = req["weight"] as? String, weight.hasPrefix("graygamma:"), let g = Double(weight.dropFirst(10)), let data = ctx.data {
    grayGamma(data, width: tw, height: th, bytesPerRow: ctx.bytesPerRow, gamma: g)
  }
  let postMs = ms(since: t1)
  let t2 = DispatchTime.now()
  guard let img = ctx.makeImage(),
        let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)
  else { throw Failure(message: "png failed") }
  CGImageDestinationAddImage(dest, img, nil)
  guard CGImageDestinationFinalize(dest) else { throw Failure(message: "png write failed") }
  return ["width": tw, "height": th, "drawMs": drawMs, "postMs": postMs, "encodeMs": ms(since: t2)]
}

func chars(_ req: [String: Any]) throws -> [String: Any] {
  let (_, p, box) = try page(req)
  let t0 = DispatchTime.now()
  let text = (p.string ?? "") as NSString
  // characterBounds(at:) does not share page.string's index space (S2: rects drift by a few characters).
  // A PDFSelection over each composed character sequence uses the same NSString range; math italic
  // letters are surrogate pairs, so the rect is repeated for every UTF-16 unit of the sequence.
  var rects: [Double] = []
  rects.reserveCapacity(text.length * 4)
  var i = 0
  while i < text.length {
    let unit = text.rangeOfComposedCharacterSequence(at: i)
    let r = p.selection(for: unit)?.bounds(for: p) ?? .null
    let rect = (r.isNull || r.isInfinite || r.width.isNaN) ? [0.0, 0, 0, 0] : topLeft(r, in: box)
    for _ in 0..<unit.length { rects += rect }
    i += unit.length
  }
  var lines: [[Int]] = []
  if let all = p.selection(for: box) {
    for line in all.selectionsByLine() {
      let range = line.range(at: 0, on: p)
      if range.location != NSNotFound && range.length > 0 { lines.append([range.location, range.length]) }
    }
  }
  return ["text": text as String, "rects": rects, "lines": lines, "ms": ms(since: t0)]
}

func links(_ req: [String: Any]) throws -> [String: Any] {
  let (doc, p, box) = try page(req)
  var result: [[String: Any]] = []
  for a in p.annotations where a.type == "Link" {
    var item: [String: Any] = ["rect": topLeft(a.bounds, in: box)]
    var destination = a.destination
    if destination == nil, let action = a.action as? PDFActionGoTo { destination = action.destination }
    if let d = destination, let target = d.page {
      let tb = target.bounds(for: .cropBox)
      item["page"] = doc.index(for: target) + 1
      // kPDFDestinationUnspecifiedValue is a huge sentinel; report it as null.
      item["point"] = [d.point.x > 1e6 ? nil : r2(d.point.x - tb.minX), d.point.y > 1e6 ? nil : r2(tb.maxY - d.point.y)] as [Any?]
    } else if let action = a.action as? PDFActionURL, let url = action.url {
      item["url"] = url.absoluteString
    }
    result.append(item)
  }
  return ["links": result]
}

func outline(_ req: [String: Any]) throws -> [String: Any] {
  guard let id = req["doc"] as? String, let doc = documents[id] else { throw Failure(message: "unknown doc") }
  var items: [[String: Any]] = []
  func walk(_ node: PDFOutline, depth: Int) {
    for i in 0..<node.numberOfChildren {
      guard let child = node.child(at: i) else { continue }
      var item: [String: Any] = ["title": child.label ?? "", "depth": depth]
      var destination = child.destination
      if destination == nil, let action = child.action as? PDFActionGoTo { destination = action.destination }
      if let d = destination, let target = d.page {
        item["page"] = doc.index(for: target) + 1
        let tb = target.bounds(for: .cropBox)
        if d.point.y < 1e6 { item["y"] = r2(tb.maxY - d.point.y) }
      }
      items.append(item)
      if items.count < 500 { walk(child, depth: depth + 1) }
    }
  }
  if let root = doc.outlineRoot { walk(root, depth: 0) }
  return ["outline": items]
}

// Bounding box of non-white ink at 1 px per point, in top-left points.
func contentBounds(_ req: [String: Any]) throws -> [String: Any] {
  let (_, p, box) = try page(req)
  let w = Int(box.width.rounded(.up)), h = Int(box.height.rounded(.up))
  guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue),
        let data = ctx.data else { throw Failure(message: "no context") }
  ctx.setFillColor(gray: 1, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.translateBy(x: -box.minX, y: -box.minY)
  p.draw(with: .cropBox, to: ctx)
  let px = data.bindMemory(to: UInt8.self, capacity: ctx.bytesPerRow * h)
  var minX = w, minY = h, maxX = -1, maxY = -1
  for y in 0..<h {
    let row = px + y * ctx.bytesPerRow
    for x in 0..<w where row[x] < 245 {
      minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    }
  }
  // Bitmap rows run top to bottom in memory, so y is already a top-left coordinate.
  if maxX < 0 { return ["bounds": NSNull()] }
  return ["bounds": [minX, minY, maxX - minX + 1, maxY - minY + 1]]
}

func handle(_ req: [String: Any]) throws -> [String: Any] {
  switch req["op"] as? String {
  case "open":
    guard let path = req["path"] as? String, let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
      throw Failure(message: "cannot open PDF")
    }
    let id = "d\(nextDocument)"; nextDocument += 1
    documents[id] = doc
    var pages: [[String: Any]] = []
    for i in 0..<doc.pageCount {
      guard let p = doc.page(at: i) else { continue }
      let b = p.bounds(for: .cropBox)
      pages.append(["width": r2(b.width), "height": r2(b.height), "rotation": p.rotation,
                    "originX": r2(b.minX), "originY": r2(b.minY), "label": p.label ?? String(i + 1)])
    }
    return ["doc": id, "pageCount": doc.pageCount, "pages": pages]
  case "render": return try render(req)
  case "chars": return try chars(req)
  case "links": return try links(req)
  case "content_bounds": return try contentBounds(req)
  case "outline": return try outline(req)
  case "close":
    if let id = req["doc"] as? String { documents[id] = nil }
    return [:]
  default: throw Failure(message: "unknown op")
  }
}

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine(strippingNewline: true) {
  if line.isEmpty { continue }
  var reply: [String: Any]
  var id: Any = NSNull()
  do {
    guard let obj = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
      throw Failure(message: "not an object")
    }
    id = obj["id"] ?? NSNull()
    reply = try autoreleasepool { try handle(obj) }
    reply["ok"] = true
  } catch let f as Failure {
    reply = ["ok": false, "error": f.message]
  } catch {
    reply = ["ok": false, "error": "\(error)"]
  }
  reply["id"] = id
  let data = try! JSONSerialization.data(withJSONObject: reply)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([10]))
}
