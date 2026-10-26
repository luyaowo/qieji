import Foundation
import UserNotifications

// Calls production planning without creating UNUserNotificationCenter or touching permissions.
@main struct ReminderPlanChecks {
    static func main() {
        let formatter = ISO8601DateFormatter()
        func date(_ value: String) -> Date { formatter.date(from: value)! }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        let now = date("2026-10-23T23:50:00+08:00")
        let task: [String: Any] = ["id": "r", "text": "合成提醒", "done": false,
            "remindAt": "2026-11-10T09:00:00+08:00", "repeat": "weekdays",
            "snoozedUntil": "2026-10-24T00:05:00+08:00"]
        var failed = 0, count = 0
        func check(_ name: String, _ condition: @autoclosure () -> Bool) {
            count += 1
            let passed = condition()
            print("\(passed ? "PASS" : "FAIL"): \(name)")
            if !passed { failed += 1 }
        }
        let plans = TaskReminderScheduler.makePlans(tasks: [task], now: now, calendar: calendar)
        let reminders = plans.flatMap(\.reminders)
        let snoozes = reminders.filter { !$0.repeats }
        check("周五跨周末延后仍在十五分钟后", snoozes.count == 1 && snoozes.first?.nextDate == date("2026-10-24T00:05:00+08:00"))
        check("工作日五条重复仍保持原09点", reminders.filter(\.repeats).count == 5 && reminders.filter(\.repeats).allSatisfy { $0.components.hour == 9 })
        check("延后与重复标识唯一", Set(reminders.map(\.identifier)).count == reminders.count)
        var completed = task; completed["done"] = true
        check("完成后撤销重复和延后", TaskReminderScheduler.makePlans(tasks: [completed], now: now, calendar: calendar).isEmpty)
        var expired = task; expired["snoozedUntil"] = "2020-01-01T00:00:00Z"
        check("过期延后不再占排期名额", TaskReminderScheduler.makePlans(tasks: [expired], now: now, calendar: calendar).flatMap(\.reminders).count == 5)
        var daily = task; daily["repeat"] = "daily"; daily.removeValue(forKey: "snoozedUntil")
        check("每天重复从最近匹配开始", TaskReminderScheduler.makePlans(tasks: [daily], now: now, calendar: calendar).first?.earliest == date("2026-10-24T09:00:00+08:00"))
        daily["repeat"] = "weekly"
        check("每周取星期而非未来首日", TaskReminderScheduler.makePlans(tasks: [daily], now: now, calendar: calendar).first?.earliest == date("2026-10-27T09:00:00+08:00"))
        var once = daily; once.removeValue(forKey: "repeat")
        check("一次性保留完整未来日期", TaskReminderScheduler.makePlans(tasks: [once], now: now, calendar: calendar).first?.earliest == date("2026-11-10T09:00:00+08:00"))
        let many = (0..<11).map { i -> [String: Any] in var t = task; t["id"] = "t\(i)"; return t }
        let selected = TaskReminderScheduler.select(plans: TaskReminderScheduler.makePlans(tasks: many, now: now, calendar: calendar))
        check("六十条上限整组纳入重复和延后", selected.count == 60 && Dictionary(grouping: selected, by: \.taskID).values.allSatisfy { $0.count == 6 })
        print("Reminder plans: \(count - failed)/\(count) passed")
        exit(failed == 0 ? 0 : 1)
    }
}
