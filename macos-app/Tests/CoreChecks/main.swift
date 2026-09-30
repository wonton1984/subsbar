import Foundation
import TestSupport
let count = try Suite.run() + M1Suite.run() + M2Suite.run()
print("PASS: \(count) contract checks")
