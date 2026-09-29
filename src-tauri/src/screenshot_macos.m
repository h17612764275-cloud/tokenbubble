#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <dispatch/dispatch.h>
#import <math.h>
#import <stdlib.h>
#import <string.h>

typedef struct {
    int32_t x;
    int32_t y;
    uint32_t width;
    uint32_t height;
} TBWindowRect;

typedef struct {
    uint8_t *png;
    size_t png_length;
    double x;
    double y;
    double logical_width;
    double logical_height;
    TBWindowRect *targets;
    size_t target_count;
    char *error;
} TBCapture;

static void tb_error(TBCapture *output, NSString *message) {
    output->error = strdup(message.UTF8String ?: "截图失败");
}

void tb_free_capture(TBCapture *capture) {
    free(capture->png);
    free(capture->targets);
    free(capture->error);
    memset(capture, 0, sizeof(*capture));
}

static SCDisplay *tb_display_at_cursor(NSArray<SCDisplay *> *displays) {
    CGEventRef event = CGEventCreate(NULL);
    CGPoint cursor = event ? CGEventGetLocation(event) : CGPointZero;
    if (event) CFRelease(event);
    for (SCDisplay *display in displays) {
        if (CGRectContainsPoint(display.frame, cursor)) return display;
    }
    // A cursor on a display seam is assigned to the nearest available display.
    SCDisplay *nearest = displays.firstObject;
    double shortest = INFINITY;
    for (SCDisplay *display in displays) {
        CGRect frame = display.frame;
        double x = fmax(frame.origin.x, fmin(cursor.x, CGRectGetMaxX(frame)));
        double y = fmax(frame.origin.y, fmin(cursor.y, CGRectGetMaxY(frame)));
        double distance = hypot(cursor.x - x, cursor.y - y);
        if (distance < shortest) { shortest = distance; nearest = display; }
    }
    return nearest;
}

int tb_capture_current_display(TBCapture *output) {
    memset(output, 0, sizeof(*output));
    @autoreleasepool {
        if (!CGPreflightScreenCaptureAccess()) {
            CGRequestScreenCaptureAccess();
            tb_error(output, @"请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中允许 Token Bubble 录制屏幕，然后重新截图；若刚授权仍失败，请重新启动应用。");
            return 0;
        }

        __block SCShareableContent *content = nil;
        __block NSError *content_error = nil;
        dispatch_semaphore_t content_semaphore = dispatch_semaphore_create(0);
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *value, NSError *error) {
            content = value;
            content_error = error;
            dispatch_semaphore_signal(content_semaphore);
        }];
        if (dispatch_semaphore_wait(content_semaphore, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
            tb_error(output, @"读取可截图窗口超时，请重试截图。");
            return 0;
        }
        if (!content) {
            tb_error(output, content_error.localizedDescription ?: @"无法读取可截图的显示器，请检查屏幕录制权限。");
            return 0;
        }
        SCDisplay *display = tb_display_at_cursor(content.displays);
        if (!display || display.width <= 0 || display.height <= 0) {
            tb_error(output, @"鼠标所在显示器不可用于截图。");
            return 0;
        }

        // SCDisplay.frame and SCWindow.frame use global screen points. The capture
        // image uses pixels, so window suggestions are projected with the actual
        // CGImage dimensions after capture rather than an assumed Retina factor.
        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
        SCStreamConfiguration *configuration = [SCStreamConfiguration new];
        size_t display_width = CGDisplayPixelsWide(display.displayID);
        size_t display_height = CGDisplayPixelsHigh(display.displayID);
        if (!display_width || !display_height) {
            tb_error(output, @"显示器像素尺寸无效。");
            return 0;
        }
        configuration.width = display_width;
        configuration.height = display_height;
        configuration.showsCursor = NO;

        __block CGImageRef image = NULL;
        __block NSError *capture_error = nil;
        __block BOOL abandoned = NO;
        NSObject *image_guard = [NSObject new];
        dispatch_semaphore_t image_semaphore = dispatch_semaphore_create(0);
        [SCScreenshotManager captureImageWithFilter:filter configuration:configuration completionHandler:^(CGImageRef value, NSError *error) {
            @synchronized (image_guard) {
                if (!abandoned) {
                    if (value) image = CGImageRetain(value);
                    capture_error = error;
                }
            }
            dispatch_semaphore_signal(image_semaphore);
        }];
        if (dispatch_semaphore_wait(image_semaphore, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0) {
            @synchronized (image_guard) {
                abandoned = YES;
                if (image) { CGImageRelease(image); image = NULL; }
            }
            tb_error(output, @"屏幕截图超时，请重试截图。");
            return 0;
        }
        if (!image) {
            tb_error(output, capture_error.localizedDescription ?: @"无法捕获屏幕，请检查屏幕录制权限。");
            return 0;
        }

        NSMutableData *png = [NSMutableData data];
        CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)png, (__bridge CFStringRef)UTTypePNG.identifier, 1, NULL);
        if (!destination) {
            CGImageRelease(image);
            tb_error(output, @"无法编码屏幕截图。");
            return 0;
        }
        CGImageDestinationAddImage(destination, image, NULL);
        BOOL encoded = CGImageDestinationFinalize(destination);
        CFRelease(destination);
        const double pixel_width = (double)CGImageGetWidth(image);
        const double pixel_height = (double)CGImageGetHeight(image);
        CGImageRelease(image);
        if (!encoded || png.length == 0) {
            tb_error(output, @"无法编码屏幕截图。");
            return 0;
        }

        output->png = malloc(png.length);
        if (!output->png) {
            tb_error(output, @"截图内存不足。");
            return 0;
        }
        memcpy(output->png, png.bytes, png.length);
        output->png_length = png.length;
        CGRect frame = display.frame;
        output->x = frame.origin.x;
        output->y = frame.origin.y;
        output->logical_width = frame.size.width;
        output->logical_height = frame.size.height;

        // ScreenCaptureKit documents which windows are available, but not their
        // order. Core Graphics enumerates on-screen windows front to back. Join
        // by windowID so the first suggested rectangle is the topmost window.
        NSMutableDictionary<NSNumber *, SCWindow *> *windows_by_id = [NSMutableDictionary dictionaryWithCapacity:content.windows.count];
        for (SCWindow *window in content.windows) {
            windows_by_id[@(window.windowID)] = window;
        }
        CFArrayRef ordered_info_ref = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
        NSArray<NSDictionary *> *ordered_info = CFBridgingRelease(ordered_info_ref);
        NSMutableArray<SCWindow *> *ordered_windows = [NSMutableArray arrayWithCapacity:content.windows.count];
        if (ordered_info) {
            for (NSDictionary *info in ordered_info) {
                NSNumber *window_id = info[(__bridge NSString *)kCGWindowNumber];
                SCWindow *window = windows_by_id[window_id];
                if (window) [ordered_windows addObject:window];
            }
        } else {
            [ordered_windows addObjectsFromArray:content.windows];
        }

        output->targets = calloc(ordered_windows.count, sizeof(TBWindowRect));
        if (!output->targets && ordered_windows.count) {
            tb_free_capture(output);
            tb_error(output, @"截图内存不足。");
            return 0;
        }
        for (SCWindow *window in ordered_windows) {
            if (!window.isOnScreen || window.windowLayer != 0 || window.owningApplication.processID == getpid()) continue;
            CGRect visible = CGRectIntersection(window.frame, frame);
            if (CGRectIsEmpty(visible) || CGRectIsNull(visible)) continue;
            int32_t left = (int32_t)lround((CGRectGetMinX(visible) - CGRectGetMinX(frame)) * pixel_width / frame.size.width);
            int32_t top = (int32_t)lround((CGRectGetMinY(visible) - CGRectGetMinY(frame)) * pixel_height / frame.size.height);
            int32_t right = (int32_t)lround((CGRectGetMaxX(visible) - CGRectGetMinX(frame)) * pixel_width / frame.size.width);
            int32_t bottom = (int32_t)lround((CGRectGetMaxY(visible) - CGRectGetMinY(frame)) * pixel_height / frame.size.height);
            if (right <= left || bottom <= top) continue;
            output->targets[output->target_count++] = (TBWindowRect){left, top, (uint32_t)(right - left), (uint32_t)(bottom - top)};
        }
        return 1;
    }
}

int tb_copy_png_to_clipboard(const uint8_t *bytes, size_t length) {
    if (!bytes || !length) return 0;
    NSData *data = [NSData dataWithBytes:bytes length:length];
    __block BOOL copied = NO;
    void (^write_pasteboard)(void) = ^{
        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        [pasteboard clearContents];
        copied = [pasteboard setData:data forType:NSPasteboardTypePNG];
    };
    if ([NSThread isMainThread]) write_pasteboard();
    else dispatch_sync(dispatch_get_main_queue(), write_pasteboard);
    return copied ? 1 : 0;
}

// ScreenCaptureKit frames use a top-left global point origin. NSWindow frames
// use a bottom-left point origin. Position directly in AppKit to avoid applying
// the screenshot window's old display scale when crossing mixed-DPI monitors.
int tb_set_window_frame(void *raw_window, double x, double y, double width, double height) {
    if (!raw_window || width <= 0 || height <= 0) return 0;
    NSWindow *window = (__bridge NSWindow *)raw_window;
    __block BOOL placed = NO;
    void (^place)(void) = ^{
        NSScreen *main = [NSScreen screens].firstObject;
        if (!main) return;
        CGFloat top = NSMaxY(main.frame);
        NSRect frame = NSMakeRect(x, top - y - height, width, height);
        [window setFrame:frame display:YES];
        placed = YES;
    };
    if ([NSThread isMainThread]) place();
    else dispatch_sync(dispatch_get_main_queue(), place);
    return placed ? 1 : 0;
}
