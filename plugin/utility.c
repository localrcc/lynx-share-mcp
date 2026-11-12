#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commdlg.h>
#include <mmsystem.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <clap/clap.h>

typedef struct {
    clap_plugin_t plugin;
    HWND window, status;
    HANDLE job;
    wchar_t project[MAX_PATH], output[MAX_PATH];
} Utility;

static bool find_lynx(wchar_t *exe) {
    DWORD size = GetEnvironmentVariableW(L"LYNX_EXE", exe, MAX_PATH);
    if (size && size < MAX_PATH) return GetFileAttributesW(exe) != INVALID_FILE_ATTRIBUTES;
    size = GetModuleFileNameW(NULL, exe, MAX_PATH);
    if (size && size < MAX_PATH) {
        const wchar_t *name = wcsrchr(exe, L'\\');
        if (name && !_wcsicmp(name + 1, L"LYNX.exe")) return true;
    }
    size = SearchPathW(NULL, L"LYNX.exe", NULL, MAX_PATH, exe, NULL);
    return size && size < MAX_PATH;
}
static const wchar_t window_class[] = L"LynxProjectUtilityEditor";
static HINSTANCE module;
static HBRUSH panel;
static HFONT normal_font, title_font;
static const char *const features[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_UTILITY, CLAP_PLUGIN_FEATURE_STEREO, NULL};
static const clap_plugin_descriptor_t descriptor = {
    CLAP_VERSION_INIT, "local.lynx.project-utility", "LYNX MCP",
    "Localrcc", "", "", "", "1.0.0", "Export saved LYNX projects", features
};

static const char *const generator_features[] = {CLAP_PLUGIN_FEATURE_INSTRUMENT, CLAP_PLUGIN_FEATURE_STEREO, NULL};
static const clap_plugin_descriptor_t generator = {
    CLAP_VERSION_INIT, "local.lynx.mcp.controller", "LYNX MCP",
    "Localrcc", "", "", "", "1.0.0", "MCP controller and project utility (silent output)", generator_features
};

static bool settings_path(wchar_t *file) {
    DWORD n = GetEnvironmentVariableW(L"APPDATA", file, MAX_PATH);
    if (!n || n >= MAX_PATH - 32) return false;
    wcscat(file, L"\\LYNX\\mcp-settings.ini");
    return true;
}

static void setup_mcp_controls(HWND window) {
    wchar_t file[MAX_PATH];
    if (!settings_path(file)) return;
    HWND combo = GetDlgItem(window, 109);
    SendMessageW(combo, CB_RESETCONTENT, 0, 0);
    SendMessageW(combo, CB_ADDSTRING, 0, (LPARAM)L"Select MIDI output");
    SendMessageW(combo, CB_SETITEMDATA, 0, (LPARAM)-1);
    int selected = 0;
    int saved = (int)GetPrivateProfileIntW(L"MCP", L"MidiPort", -1, file);
    for (UINT i = 0; i < midiOutGetNumDevs(); ++i) {
        MIDIOUTCAPSW caps;
        if (midiOutGetDevCapsW(i, &caps, sizeof caps) != MMSYSERR_NOERROR) continue;
        LRESULT row = SendMessageW(combo, CB_ADDSTRING, 0, (LPARAM)caps.szPname);
        if (row < 0) continue;
        SendMessageW(combo, CB_SETITEMDATA, row, i);
        if ((int)i == saved) selected = (int)row;
    }
    SendMessageW(combo, CB_SETCURSEL, selected, 0);
    SetWindowTextW(GetDlgItem(window, 108), GetPrivateProfileIntW(L"MCP", L"Enabled", 1, file)
        ? L"MCP enabled" : L"MCP disabled");
}

static void save_mcp_setting(Utility *utility, int control_id) {
    wchar_t file[MAX_PATH];
    if (!settings_path(file)) return;
    BOOL ok;
    if (control_id == 108) {
        bool enabled = !GetPrivateProfileIntW(L"MCP", L"Enabled", 1, file);
        ok = WritePrivateProfileStringW(L"MCP", L"Enabled", enabled ? L"1" : L"0", file);
        if (ok) {
            HWND toggle = GetDlgItem(utility->window, 108);
            SetWindowTextW(toggle, enabled ? L"MCP enabled" : L"MCP disabled");
            InvalidateRect(toggle, NULL, TRUE);
            SetWindowTextW(utility->status, enabled ? L"MCP tools enabled." : L"MCP tools disabled.");
        }
    } else {
        HWND combo = GetDlgItem(utility->window, 109);
        LRESULT row = SendMessageW(combo, CB_GETCURSEL, 0, 0);
        if (row < 0) return;
        wchar_t value[20];
        swprintf(value, 20, L"%d", (int)SendMessageW(combo, CB_GETITEMDATA, row, 0));
        ok = WritePrivateProfileStringW(L"MCP", L"MidiPort", value, file);
        if (ok) SetWindowTextW(utility->status, L"MIDI port selection saved.");
    }
    if (!ok) {
        setup_mcp_controls(utility->window);
        SetWindowTextW(utility->status, L"Could not save MCP settings.");
    }
}

static bool choose(HWND owner, wchar_t *file, bool save) {
    OPENFILENAMEW dialog = {0};
    dialog.lStructSize = sizeof dialog;
    dialog.hwndOwner = owner;
    dialog.lpstrFile = file;
    dialog.nMaxFile = MAX_PATH;
    dialog.lpstrFilter = save ? L"Wave audio (*.wav)\0*.wav\0" : L"Projects (*.lynx;*.flp;*.mid)\0*.lynx;*.flp;*.mid\0";
    dialog.lpstrDefExt = save ? L"wav" : NULL;
    dialog.Flags = OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST | (save ? OFN_OVERWRITEPROMPT : OFN_FILEMUSTEXIST);
    return save ? GetSaveFileNameW(&dialog) : GetOpenFileNameW(&dialog);
}

static void start_export(Utility *utility, bool pattern) {
    if (utility->job) return;
    if (!utility->project[0]) {
        SetWindowTextW(utility->status, L"Choose a saved project first.");
        return;
    }
    utility->output[0] = 0;
    if (!choose(utility->window, utility->output, true)) return;
    if (GetFileAttributesW(utility->output) != INVALID_FILE_ATTRIBUTES) {
        SetWindowTextW(utility->status, L"Choose a new WAV filename.");
        return;
    }
    wchar_t exe[MAX_PATH], cwd[MAX_PATH];
    if (!find_lynx(exe)) {
        SetWindowTextW(utility->status, L"Set LYNX_EXE to your LYNX executable.");
        return;
    }
    wcscpy(cwd, exe);
    wchar_t *last_slash = wcsrchr(cwd, L'\\');
    if (last_slash) *last_slash = 0;
    wchar_t command[4 * MAX_PATH];
    swprintf(command, 4 * MAX_PATH, L"\"%ls\" %ls \"%ls\" \"%ls\"%ls",
             exe, pattern ? L"--render" : L"--export", utility->project, utility->output, pattern ? L" 5" : L"");
    STARTUPINFOW startup = { .cb = sizeof startup };
    PROCESS_INFORMATION process;
    if (!CreateProcessW(exe, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, last_slash ? cwd : NULL, &startup, &process)) {
        SetWindowTextW(utility->status, L"Could not start LYNX.");
        return;
    }
    CloseHandle(process.hThread);
    utility->job = process.hProcess;
    SetWindowTextW(utility->status, L"Rendering audio...");
    SetTimer(utility->window, 1, 200, NULL);
}

static HWND control(HWND parent, const wchar_t *type, const wchar_t *label,
                    int id, int x, int y, int w, int h, DWORD style) {
    HWND item = CreateWindowExW(0, type, label, WS_CHILD | WS_VISIBLE | style, x, y, w, h,
                                parent, (HMENU)(INT_PTR)id, module, NULL);
    SendMessageW(item, WM_SETFONT, (WPARAM)(id == 105 ? title_font : normal_font), TRUE);
    return item;
}

static LRESULT CALLBACK editor_proc(HWND window, UINT message, WPARAM w, LPARAM l) {
    if (message == WM_NCCREATE) {
        CREATESTRUCTW *creation = (CREATESTRUCTW *)l;
        SetWindowLongPtrW(window, GWLP_USERDATA, (LONG_PTR)creation->lpCreateParams);
    }
    Utility *utility = (Utility *)GetWindowLongPtrW(window, GWLP_USERDATA);
    switch (message) {
        case WM_CREATE: {
            wchar_t exe[MAX_PATH];
            control(window, L"STATIC", L"LYNX MCP", 105, 16, 18, 600, 27, SS_CENTER);
            control(window, L"BUTTON", L"Choose saved project...", 101, 212, 58, 208, 34, WS_TABSTOP | BS_OWNERDRAW);
            control(window, L"STATIC", utility->project[0] ? utility->project : L"No project selected", 102,
                    76, 103, 480, 22, SS_CENTER | SS_PATHELLIPSIS | SS_NOPREFIX);
            control(window, L"BUTTON", L"Export song to WAV...", 103, 103, 139, 206, 34, WS_TABSTOP | BS_OWNERDRAW);
            control(window, L"BUTTON", L"Render pattern (5 s)...", 104, 323, 139, 206, 34, WS_TABSTOP | BS_OWNERDRAW);
            utility->status = control(window, L"STATIC", utility->job ? L"Rendering audio..." :
                find_lynx(exe) ? L"LYNX is ready." : L"Set LYNX_EXE to your LYNX executable.",
                106, 52, 188, 528, 22, SS_CENTER | SS_NOPREFIX);
            control(window, L"BUTTON", L"MCP enabled", 108, 103, 220, 144, 32, WS_TABSTOP | BS_OWNERDRAW);

            control(window, L"COMBOBOX", L"", 109, 261, 220, 268, 180, WS_TABSTOP | CBS_DROPDOWNLIST | CBS_OWNERDRAWFIXED | CBS_HASSTRINGS | WS_VSCROLL);
            setup_mcp_controls(window);
            control(window, L"STATIC", L"Live control needs a MIDI loopback configured in LYNX.", 111, 16, 268, 600, 20, SS_CENTER);
            control(window, L"STATIC", L"", 0, 104, 306, 424, 1, SS_ETCHEDHORZ);
            control(window, L"STATIC", L"Made by localrcc", 107, 16, 322, 600, 20, SS_CENTER);
            if (utility->job) SetTimer(window, 1, 200, NULL);
            return 0;
        }
        case WM_CTLCOLORBTN:
        case WM_CTLCOLORSTATIC: {
            HDC dc = (HDC)w;
            int id = GetDlgCtrlID((HWND)l);
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, id == 105 ? RGB(239, 240, 243) : RGB(163, 170, 182));
            return (LRESULT)panel;
        }
        case WM_MEASUREITEM: {
            MEASUREITEMSTRUCT *item = (MEASUREITEMSTRUCT *)l;
            if (item->CtlID != 109) break;
            item->itemHeight = 28;
            return TRUE;
        }
        case WM_DRAWITEM: {
            DRAWITEMSTRUCT *item = (DRAWITEMSTRUCT *)l;
            RECT bounds = item->rcItem;
            if (item->CtlID == 109) {
                bool selected = (item->itemState & ODS_SELECTED) && !(item->itemState & ODS_COMBOBOXEDIT);
                HBRUSH background = CreateSolidBrush(selected ? RGB(100, 36, 42) : RGB(42, 46, 55));
                FillRect(item->hDC, &bounds, background);
                DeleteObject(background);
                if (item->itemID != (UINT)-1) {
                    wchar_t name[64] = {0};
                    SendMessageW(item->hwndItem, CB_GETLBTEXT, item->itemID, (LPARAM)name);
                    HGDIOBJ old_font = SelectObject(item->hDC, normal_font);
                    SetBkMode(item->hDC, TRANSPARENT);
                    SetTextColor(item->hDC, RGB(239, 240, 243));
                    bounds.left += 10;
                    bounds.right -= 6;
                    DrawTextW(item->hDC, name, -1, &bounds, DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
                    SelectObject(item->hDC, old_font);
                }
                return TRUE;
            }
            wchar_t label[96];
            GetWindowTextW(item->hwndItem, label, 96);
            bool primary = item->CtlID == 101 ||
                (item->CtlID == 108 && !wcscmp(label, L"MCP enabled"));
            bool pressed = (item->itemState & ODS_SELECTED) != 0;
            COLORREF color = primary ? (pressed ? RGB(174, 36, 44) : RGB(209, 43, 51)) :
                (pressed ? RGB(57, 63, 74) : RGB(42, 46, 55));
            FillRect(item->hDC, &bounds, panel);
            HBRUSH fill = CreateSolidBrush(color);
            HGDIOBJ old_brush = SelectObject(item->hDC, fill);
            HGDIOBJ old_pen = SelectObject(item->hDC, GetStockObject(NULL_PEN));
            RoundRect(item->hDC, bounds.left, bounds.top, bounds.right, bounds.bottom, 9, 9);
            SelectObject(item->hDC, old_pen);
            SelectObject(item->hDC, old_brush);
            DeleteObject(fill);
            HGDIOBJ old_font = SelectObject(item->hDC, normal_font);
            SetBkMode(item->hDC, TRANSPARENT);
            SetTextColor(item->hDC, RGB(239, 240, 243));
            DrawTextW(item->hDC, label, -1, &bounds, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
            SelectObject(item->hDC, old_font);
            if (item->itemState & ODS_FOCUS) {
                InflateRect(&bounds, -4, -4);
                DrawFocusRect(item->hDC, &bounds);
            }
            return TRUE;
        }
        case WM_COMMAND:
            switch (LOWORD(w)) {
                case 108: save_mcp_setting(utility, 108); return 0;
                case 109:
                    if (HIWORD(w) == CBN_SELCHANGE) save_mcp_setting(utility, 109);
                    return 0;
                case 101:
                    if (!utility->job && choose(window, utility->project, false))
                        SetDlgItemTextW(window, 102, utility->project);
                    return 0;
                case 103: start_export(utility, false); return 0;
                case 104: start_export(utility, true); return 0;
            }
            break;
        case WM_TIMER:
            if (utility->job && WaitForSingleObject(utility->job, 0) == WAIT_OBJECT_0) {
                DWORD code = 1;
                WIN32_FILE_ATTRIBUTE_DATA info;
                GetExitCodeProcess(utility->job, &code);
                CloseHandle(utility->job);
                utility->job = NULL;
                KillTimer(window, 1);
                bool success = code == 0 && GetFileAttributesExW(utility->output, GetFileExInfoStandard, &info)
                    && (info.nFileSizeHigh || info.nFileSizeLow > 44);
                SetWindowTextW(utility->status, success ? L"WAV saved." : L"LYNX did not produce a usable WAV.");
            }
            return 0;
        case WM_NCDESTROY:
            if (utility) utility->window = NULL;
            break;
    }
    return DefWindowProcW(window, message, w, l);
}

static bool api_supported(const clap_plugin_t *p, const char *api, bool floating) {
    return !floating && strcmp(api, CLAP_WINDOW_API_WIN32) == 0;
}
static bool preferred(const clap_plugin_t *p, const char **api, bool *floating) {
    *api = CLAP_WINDOW_API_WIN32;
    *floating = false;
    return true;
}
static bool gui_create(const clap_plugin_t *p, const char *api, bool floating) {
    return api_supported(p, api, floating);
}
static void gui_destroy(const clap_plugin_t *p) {
    Utility *utility = p->plugin_data;
    if (utility->window) DestroyWindow(utility->window);
}
static bool gui_size(const clap_plugin_t *p, uint32_t *w, uint32_t *h) {
    *w = 632;
    *h = 358;
    return true;
}
static bool gui_parent(const clap_plugin_t *p, const clap_window_t *parent) {
    Utility *utility = p->plugin_data;
    if (!parent || !api_supported(p, parent->api, false) || !parent->win32) return false;
    gui_destroy(p);
    utility->window = CreateWindowExW(0, window_class, L"", WS_CHILD | WS_CLIPCHILDREN,
        0, 0, 632, 358, parent->win32, NULL, module, utility);
    return utility->window != NULL;
}
static bool gui_show(const clap_plugin_t *p) {
    Utility *utility = p->plugin_data;
    if (!utility->window) return false;
    ShowWindow(utility->window, SW_SHOW);
    return true;
}
static bool gui_hide(const clap_plugin_t *p) {
    Utility *utility = p->plugin_data;
    if (!utility->window) return false;
    ShowWindow(utility->window, SW_HIDE);
    return true;
}
static bool gui_scale(const clap_plugin_t *p, double scale) { return scale == 1.0; }
static bool gui_can_resize(const clap_plugin_t *p) { return false; }
static bool gui_set_size(const clap_plugin_t *p, uint32_t w, uint32_t h) { return w == 632 && h == 358; }
static bool gui_hints(const clap_plugin_t *p, clap_gui_resize_hints_t *hints) { return false; }
static bool gui_transient(const clap_plugin_t *p, const clap_window_t *window) { return false; }
static void gui_title(const clap_plugin_t *p, const char *title) {}
static const clap_plugin_gui_t gui = {
    api_supported, preferred, gui_create, gui_destroy, gui_scale, gui_size, gui_can_resize,
    gui_hints, gui_size, gui_set_size, gui_parent, gui_transient, gui_title, gui_show, gui_hide
};

static uint32_t port_count(const clap_plugin_t *p, bool input) { return input && p->desc == &generator ? 0 : 1; }
static bool port_get(const clap_plugin_t *p, uint32_t index, bool input, clap_audio_port_info_t *port) {
    if (index || (input && p->desc == &generator)) return false;
    *port = (clap_audio_port_info_t) {
        .id = input ? 0 : 1, .flags = CLAP_AUDIO_PORT_IS_MAIN | CLAP_AUDIO_PORT_SUPPORTS_64BITS,
        .channel_count = 2, .port_type = CLAP_PORT_STEREO, .in_place_pair = p->desc == &generator ? CLAP_INVALID_ID : (input ? 1 : 0)
    };
    strcpy(port->name, input ? "Stereo input" : "Stereo output");
    return true;
}
static const clap_plugin_audio_ports_t ports = {port_count, port_get};

static clap_process_status process(const clap_plugin_t *p, const clap_process_t *block) {
    if (!block->audio_outputs_count) return CLAP_PROCESS_CONTINUE;
    const clap_audio_buffer_t *in = block->audio_inputs_count ? block->audio_inputs : NULL;
    clap_audio_buffer_t *out = block->audio_outputs;
    out->constant_mask = in ? in->constant_mask : 0;
    for (uint32_t ch = 0; ch < out->channel_count; ++ch) {
        if (out->data32 && in && in->data32 && ch < in->channel_count)
            memmove(out->data32[ch], in->data32[ch], block->frames_count * sizeof(float));
        else if (out->data64 && in && in->data64 && ch < in->channel_count)
            memmove(out->data64[ch], in->data64[ch], block->frames_count * sizeof(double));
        else if (out->data32) memset(out->data32[ch], 0, block->frames_count * sizeof(float));
        else if (out->data64) memset(out->data64[ch], 0, block->frames_count * sizeof(double));
    }
    return CLAP_PROCESS_CONTINUE;
}
static const void *extension(const clap_plugin_t *p, const char *id) {
    if (!strcmp(id, CLAP_EXT_GUI)) return &gui;
    if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &ports;
    return NULL;
}
static bool plugin_init(const clap_plugin_t *p) { return true; }
static bool activate(const clap_plugin_t *p, double rate, uint32_t min, uint32_t max) { return true; }
static void noop(const clap_plugin_t *p) {}
static void destroy(const clap_plugin_t *p) {
    Utility *utility = p->plugin_data;
    gui_destroy(p);
    if (utility->job) CloseHandle(utility->job);
    free(utility);
}
static uint32_t count(const clap_plugin_factory_t *f) { return 2; }
static const clap_plugin_descriptor_t *describe(const clap_plugin_factory_t *f, uint32_t i) {
    return i == 0 ? &descriptor : (i == 1 ? &generator : NULL);
}
static const clap_plugin_t *create(const clap_plugin_factory_t *f, const clap_host_t *host, const char *id) {
    if (!clap_version_is_compatible(host->clap_version)) return NULL;
    const clap_plugin_descriptor_t *selected = NULL;
    if (!strcmp(id, descriptor.id)) selected = &descriptor;
    if (!strcmp(id, generator.id)) selected = &generator;
    if (!selected) return NULL;
    Utility *utility = calloc(1, sizeof *utility);
    if (!utility) return NULL;
    utility->plugin = (clap_plugin_t) {
        selected, utility, plugin_init, destroy, activate, noop, plugin_init,
        noop, noop, process, extension, noop
    };
    return &utility->plugin;
}
static const clap_plugin_factory_t factory = {count, describe, create};
static unsigned references;
static bool init(const char *file) {
    if (references) { ++references; return true; }
    panel = CreateSolidBrush(RGB(22, 23, 27));
    normal_font = CreateFontW(-14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    title_font = CreateFontW(-22, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    WNDCLASSW wc = { .lpfnWndProc = editor_proc, .hInstance = module, .lpszClassName = window_class,
                     .hCursor = LoadCursorW(NULL, MAKEINTRESOURCEW(32512)),
                     .hbrBackground = panel };
    if (!RegisterClassW(&wc)) {
        DeleteObject(panel);
        DeleteObject(normal_font);
        DeleteObject(title_font);
        return false;
    }
    references = 1;
    return true;
}
static void deinit(void) {
    if (references && !--references) {
        UnregisterClassW(window_class, module);
        DeleteObject(panel);
        DeleteObject(normal_font);
        DeleteObject(title_font);
    }
}
static const void *get_factory(const char *id) {
    return strcmp(id, CLAP_PLUGIN_FACTORY_ID) == 0 ? &factory : NULL;
}
BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    if (reason == DLL_PROCESS_ATTACH) module = instance;
    return TRUE;
}
CLAP_EXPORT const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, init, deinit, get_factory};






