import Foundation
import UserNotifications

final class TaskReminderScheduler: NSObject, UNUserNotificationCenterDelegate {
    enum RepeatRule: String {
        case daily, weekdays, weekly
    }

    struct Reminder {
        let identifier: String
        let taskID: String
        let text: String
        let components: DateComponents
        let repeats: Bool
        let nextDate: Date
    }

    struct TaskPlan {
        let taskID: String
        let text: String
        let reminders: [Reminder]

        var earliest: Date { reminders.map(\.nextDate).min() ?? .distantFuture }
    }

    private let center = UNUserNotificationCenter.current()
    private static let identifierPrefix = "qieji.reminder."
    private let categoryIdentifier = "qieji.task"
    private let completeActionIdentifier = "qieji.complete"
    private let snoozeActionIdentifier = "qieji.snooze15"
    private static let maxScheduled = 60
    private var generation = 0
    private var latestTasks: Any?

    var onOpen: (() -> Void)?
    var onStatus: ((String) -> Void)?
    #if os(macOS)
    var onOpenTask: ((String) -> Void)?
    var onCompleteTask: ((String) -> Void)?
    var onSnoozeTask: ((String) -> Void)?
    private var lastPermissionStatus: String?
    private var limitExceeded = false
    #endif

    private func reportPermission(_ status: String) {
        #if os(macOS)
        guard lastPermissionStatus != status else { return }
        lastPermissionStatus = status
        #endif
        onStatus?(status)
    }

    private func reportLimit(_ exceeded: Bool) {
        #if os(macOS)
        guard limitExceeded != exceeded else { return }
        limitExceeded = exceeded
        onStatus?(exceeded ? "limit" : "limitCleared")
        #endif
    }

    override init() {
        super.init()
        center.delegate = self
        center.setNotificationCategories([Self.makeCategory(
            category: categoryIdentifier,
            complete: completeActionIdentifier,
            snooze: snoozeActionIdentifier
        )])
    }

    private static func makeCategory(category: String, complete: String, snooze: String) -> UNNotificationCategory {
        let completeAction = UNNotificationAction(identifier: complete, title: "完成", options: [])
        let snoozeAction = UNNotificationAction(identifier: snooze, title: "15 分钟后再提醒", options: [])
        return UNNotificationCategory(
            identifier: category,
            actions: [completeAction, snoozeAction],
            intentIdentifiers: [],
            options: []
        )
    }

    private static func reminderDate(_ raw: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: raw) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: raw)
    }

    func sync(tasks: Any?) {
        guard let tasks = tasks as? [[String: Any]] else { return }
        latestTasks = tasks
        generation += 1
        let currentGeneration = generation
        let now = Date()
        let plans = Self.makePlans(tasks: tasks, now: now)
        let schedulable = plans.compactMap { plan -> TaskPlan? in
            let upcoming = plan.reminders.filter { $0.nextDate > now }
            return upcoming.isEmpty ? nil : TaskPlan(taskID: plan.taskID, text: plan.text, reminders: upcoming)
        }
        let reminders = Self.select(plans: schedulable)
        let truncated = schedulable.reduce(0) { $0 + $1.reminders.count } > reminders.count
        let keepDelivered = Set(plans.flatMap(\.reminders).map(\.identifier))

        center.getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                guard let self, self.generation == currentGeneration else { return }
                if reminders.isEmpty {
                    self.reportLimit(false)
                    self.reconcile(reminders: [], keepDelivered: keepDelivered, generation: currentGeneration)
                    return
                }
                switch settings.authorizationStatus {
                case .notDetermined:
                    self.center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                        DispatchQueue.main.async {
                            guard self.generation == currentGeneration else { return }
                            self.reportPermission(granted ? "authorized" : "denied")
                            self.reportLimit(granted && truncated)
                            self.reconcile(
                                reminders: granted ? reminders : [],
                                keepDelivered: keepDelivered,
                                generation: currentGeneration
                            )
                        }
                    }
                case .authorized, .provisional:
                    self.reportPermission("authorized")
                    self.reportLimit(truncated)
                    self.reconcile(reminders: reminders, keepDelivered: keepDelivered, generation: currentGeneration)
                default:
                    self.reportPermission("denied")
                    self.reportLimit(false)
                    self.reconcile(reminders: [], keepDelivered: keepDelivered, generation: currentGeneration)
                }
            }
        }
    }

    func refresh() {
        if let latestTasks { sync(tasks: latestTasks) }
    }

    static func makePlans(tasks: [[String: Any]], now: Date, calendar: Calendar = .current) -> [TaskPlan] {
        tasks.compactMap { task -> TaskPlan? in
            guard
                task["done"] as? Bool == false,
                let id = task["id"] as? String, !id.isEmpty,
                let text = task["text"] as? String,
                !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                let rawDate = task["remindAt"] as? String,
                let date = reminderDate(rawDate)
            else { return nil }
            let rule = (task["repeat"] as? String).flatMap(RepeatRule.init(rawValue:))
            var reminders: [Reminder]
            if let rule {
                reminders = repeatingReminders(id: id, text: text, anchor: date, rule: rule, now: now, calendar: calendar)
            } else {
                reminders = [oneShotReminder(id: id, text: text, date: date, calendar: calendar)]
            }
            // Snoozing one occurrence never changes its recurring wall-clock rule.
            if rule != nil, let rawSnooze = task["snoozedUntil"] as? String,
               let snooze = reminderDate(rawSnooze), snooze > now {
                reminders.append(oneShotReminder(id: id, text: text, date: snooze, calendar: calendar, kind: "snooze"))
            }
            guard !reminders.isEmpty else { return nil }
            return TaskPlan(taskID: id, text: text, reminders: reminders)
        }
    }

    private static func identifier(id: String, kind: String) -> String {
        // Imported IDs can contain punctuation; encode them so task IDs cannot
        // collide with the repeat/snooze branches of another task.
        identifierPrefix + Data(id.utf8).base64EncodedString() + "." + kind
    }

    private static func oneShotReminder(id: String, text: String, date: Date, calendar: Calendar, kind: String = "once") -> Reminder {
        var components = calendar.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: date
        )
        components.timeZone = calendar.timeZone
        return Reminder(
            identifier: identifier(id: id, kind: kind),
            taskID: id,
            text: text,
            components: components,
            repeats: false,
            nextDate: date
        )
    }

    private static func repeatingReminders(id: String, text: String, anchor: Date, rule: RepeatRule, now: Date, calendar: Calendar) -> [Reminder] {
        let time = calendar.dateComponents([.hour, .minute], from: anchor)
        let anchorWeekday = calendar.component(.weekday, from: anchor)
        let weekdays: [Int]
        switch rule {
        case .daily: weekdays = [0]
        case .weekdays: weekdays = [2, 3, 4, 5, 6]
        case .weekly: weekdays = [anchorWeekday]
        }
        return weekdays.compactMap { weekday in
            var components = DateComponents()
            components.hour = time.hour
            components.minute = time.minute
            components.timeZone = calendar.timeZone
            if weekday > 0 { components.weekday = weekday }
            guard let next = calendar.nextDate(after: now, matching: components, matchingPolicy: .nextTimePreservingSmallerComponents, repeatedTimePolicy: .first) else {
                return nil
            }
            return Reminder(
                identifier: identifier(id: id, kind: "repeat.\(weekday)"),
                taskID: id,
                text: text,
                components: components,
                repeats: true,
                nextDate: next
            )
        }
    }

    static func select(plans: [TaskPlan]) -> [Reminder] {
        var selected: [Reminder] = []
        for plan in plans.sorted(by: { $0.earliest < $1.earliest }) {
            guard selected.count + plan.reminders.count <= maxScheduled else { break }
            selected.append(contentsOf: plan.reminders)
        }
        return selected
    }

    private func sameComponents(_ left: DateComponents, _ right: DateComponents) -> Bool {
        left.hour == right.hour && left.minute == right.minute && left.weekday == right.weekday
            && left.timeZone == right.timeZone
    }

    private func reconcile(reminders: [Reminder], keepDelivered: Set<String>, generation: Int) {
        center.getPendingNotificationRequests { [weak self] pending in
            DispatchQueue.main.async {
                guard let self, self.generation == generation else { return }
                let desired = reminders.reduce(into: [String: Reminder]()) { result, reminder in
                    result[reminder.identifier] = reminder
                }
                var unchanged = Set<String>()
                var remove = [String]()
                for request in pending where request.identifier.hasPrefix(Self.identifierPrefix) {
                    guard
                        let reminder = desired[request.identifier],
                        let trigger = request.trigger as? UNCalendarNotificationTrigger,
                        trigger.repeats == reminder.repeats,
                        request.content.body == reminder.text
                    else {
                        remove.append(request.identifier)
                        continue
                    }
                    if reminder.repeats {
                        if self.sameComponents(trigger.dateComponents, reminder.components) {
                            unchanged.insert(request.identifier)
                        } else {
                            remove.append(request.identifier)
                        }
                    } else if let scheduledDate = trigger.nextTriggerDate(),
                              abs(scheduledDate.timeIntervalSince(reminder.nextDate)) < 1 {
                        unchanged.insert(request.identifier)
                    } else {
                        remove.append(request.identifier)
                    }
                }
                if !remove.isEmpty { self.center.removePendingNotificationRequests(withIdentifiers: remove) }

                for reminder in reminders where !unchanged.contains(reminder.identifier) {
                    let content = UNMutableNotificationContent()
                    content.title = "且记提醒"
                    content.body = reminder.text
                    content.sound = .default
                    content.threadIdentifier = "qieji"
                    content.categoryIdentifier = self.categoryIdentifier
                    content.userInfo = ["taskId": reminder.taskID]

                    let trigger = UNCalendarNotificationTrigger(
                        dateMatching: reminder.components,
                        repeats: reminder.repeats
                    )
                    let request = UNNotificationRequest(
                        identifier: reminder.identifier,
                        content: content,
                        trigger: trigger
                    )
                    self.center.add(request) { [weak self] error in
                        DispatchQueue.main.async {
                            guard let self else { return }
                            if self.generation != generation {
                                self.refresh()
                            } else if error != nil {
                                self.onStatus?("failed")
                            }
                        }
                    }
                }
            }
        }

        center.getDeliveredNotifications { [weak self] delivered in
            guard let self, self.generation == generation else { return }
            let canceled = delivered.map(\.request.identifier).filter {
                $0.hasPrefix(Self.identifierPrefix) && !keepDelivered.contains($0)
            }
            if !canceled.isEmpty {
                self.center.removeDeliveredNotifications(withIdentifiers: canceled)
            }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            #if os(macOS)
            let taskID = response.notification.request.content.userInfo["taskId"] as? String
            switch response.actionIdentifier {
            case self.completeActionIdentifier:
                if let taskID, let onCompleteTask = self.onCompleteTask { onCompleteTask(taskID) } else { self.onOpen?() }
            case self.snoozeActionIdentifier:
                if let taskID, let onSnoozeTask = self.onSnoozeTask { onSnoozeTask(taskID) } else { self.onOpen?() }
            default:
                if let taskID, let openTask = self.onOpenTask { openTask(taskID) } else { self.onOpen?() }
            }
            #else
            self.onOpen?()
            #endif
        }
        completionHandler()
    }
}
