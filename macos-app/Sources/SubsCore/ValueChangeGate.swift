/// Records a render input before side effects, so repeated asynchronous notifications are no-ops.
public struct ValueChangeGate<Value: Equatable> {
    private var previous: Value?
    public init() {}
    public mutating func accept(_ value: Value) -> Bool {
        guard previous != value else { return false }
        previous = value
        return true
    }
}
