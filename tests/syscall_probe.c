/* Deliberately invokes low-level bypass surfaces. Only own fixture paths. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#ifdef __linux__
#include <linux/io_uring.h>
#include <sys/syscall.h>
#endif

int main(int argc, char **argv) {
    if (argc != 2) return 2;
#ifdef __APPLE__
    int fd = open(argv[1], O_RDONLY);
    if (fd < 0) return 3;
    errno = 0;
    int a = fcntl(fd, 80, 0);
    int ea = errno;
    errno = 0;
    int b = fcntl(fd, 110, fd);
    int eb = errno;
    close(fd);
    printf("{\"fcntl80\":{\"result\":%d,\"errno\":%d},\"fcntl110\":{\"result\":%d,\"errno\":%d}}\n", a, ea, b, eb);
#elif defined(__linux__)
    errno = 0;
    int a = socket(AF_VSOCK, SOCK_STREAM, 0);
    int ea = errno;
    if (a >= 0) close(a);
    struct io_uring_params params;
    memset(&params, 0, sizeof(params));
    errno = 0;
    int b = (int)syscall(__NR_io_uring_setup, 1, &params);
    int eb = errno;
    if (b >= 0) close(b);
    printf("{\"AF_VSOCK\":{\"result\":%d,\"errno\":%d},\"io_uring_setup\":{\"result\":%d,\"errno\":%d}}\n", a, ea, b, eb);
#else
    fprintf(stderr, "unsupported platform\n");
    return 4;
#endif
    return 0;
}
