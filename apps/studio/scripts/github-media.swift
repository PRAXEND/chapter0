import Foundation
import CFNetwork

// Node validates the destination before each request. Return redirects as headers
// so URLSession cannot follow a Location outside that validation boundary.
let report = FileHandle(fileDescriptor: 3)
func send(_ value: [String: Any]) {
    if let json = try? JSONSerialization.data(withJSONObject: value) {
        report.write(json)
    }
    try? report.close()
}

final class Transfer: NSObject, URLSessionDataDelegate {
    let limit: Int
    var received = 0
    var acceptedBody = false
    let done = DispatchSemaphore(value: 0)
    var failed = false
    init(limit: Int) { self.limit = limit }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        var headers: [String: String] = [:]
        for key in ["Content-Type", "Content-Length", "Location", "Retry-After"] {
            headers[key.lowercased()] = http.value(forHTTPHeaderField: key)
        }
        send(["status": http.statusCode, "headers": headers])
        acceptedBody = http.statusCode == 200 && http.expectedContentLength <= Int64(limit)
        completionHandler(acceptedBody ? .allow : .cancel)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        received += data.count
        guard received <= limit else { failed = true; dataTask.cancel(); return }
        do { try FileHandle.standardOutput.write(contentsOf: data) }
        catch { failed = true; dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error as NSError?, acceptedBody || error.code != NSURLErrorCancelled {
            failed = true
            // The domain/code suffice for diagnostics; URLs may contain signed query strings.
            FileHandle.standardError.write(Data("\(error.domain) \(error.code)\n".utf8))
        }
        done.signal()
    }
}

let args = CommandLine.arguments
guard args.count == 5, let url = URL(string: args[1]), url.scheme == "https",
      let limit = Int(args[2]), limit > 0 else { exit(2) }
let routes = CFNetworkCopySystemProxySettings().flatMap { settings in
    CFNetworkCopyProxiesForURL(url as CFURL, settings.takeRetainedValue()).takeRetainedValue() as? [[String: Any]]
}
if routes?.first == nil || routes?.first?[kCFProxyTypeKey as String] as? String == kCFProxyTypeNone as String {
    send(["direct": true])
    exit(0)
}
let config = URLSessionConfiguration.ephemeral
config.httpCookieStorage = nil
config.httpShouldSetCookies = false
config.urlCredentialStorage = nil
config.urlCache = nil
config.requestCachePolicy = .reloadIgnoringLocalCacheData
let transfer = Transfer(limit: limit)
let session = URLSession(configuration: config, delegate: transfer, delegateQueue: nil)
var request = URLRequest(url: url)
request.setValue(args[3], forHTTPHeaderField: "Accept")
request.setValue(args[4], forHTTPHeaderField: "User-Agent")
session.dataTask(with: request).resume()
transfer.done.wait()
exit(transfer.failed ? 1 : 0)
