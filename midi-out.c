#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int list_ports(void) {
    for (UINT i = 0; i < midiOutGetNumDevs(); ++i) {
        MIDIOUTCAPSW caps;
        char name[128];
        if (midiOutGetDevCapsW(i, &caps, sizeof caps) != MMSYSERR_NOERROR) continue;
        if (WideCharToMultiByte(CP_UTF8, 0, caps.szPname, -1, name, sizeof name, NULL, NULL))
            printf("%u\t%s\n", i, name);
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "list")) return list_ports();
    if (argc < 4 || strcmp(argv[1], "send")) return 2;
    UINT port = (UINT)strtoul(argv[2], NULL, 10);
    HMIDIOUT device;
    MMRESULT result = midiOutOpen(&device, port, 0, 0, CALLBACK_NULL);
    if (result != MMSYSERR_NOERROR) {
        fprintf(stderr, "Could not open MIDI output %u (WinMM error %u)\n", port, result);
        return 1;
    }
    for (int i = 3; i < argc && result == MMSYSERR_NOERROR; ++i)
        result = midiOutShortMsg(device, strtoul(argv[i], NULL, 10));
    midiOutClose(device);
    if (result != MMSYSERR_NOERROR) fprintf(stderr, "MIDI send failed (WinMM error %u)\n", result);
    return result != MMSYSERR_NOERROR;
}

