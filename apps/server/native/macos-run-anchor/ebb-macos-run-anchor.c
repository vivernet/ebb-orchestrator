/*
 * ebb-macos-run-anchor.c — first-party Darwin anchor процесс-group containment.
 *
 * Назначение: для одного Run Ebb Orchestrator создаёт живую сессию/процессную
 * группу, сам является её лидером и единственным отправителем сигналов в свою
 * группу. Частный унаследованный control-канал отделён от stdout/stderr payload
 * (не наследуется исполняемым Hermes). Протокол nonce-bound: READY/ACK/STOP
 * фреймы с bounded timeouts. До READY payload не запускается; EOF закрывает
 * гейт и запускает self-stop (TERM → bounded grace → self-inclusive KILL) без
 * reconnect-демона.
 *
 * Безопасность/контракт:
 *  - Нет внешних числовых PID/PGID сигналов от Ebb: команды приходят только
 *    по живому приватному каналу; после рестарта Ebb канала нет → UNKNOWN.
 *  - Используются только SDK-shipped/exported интерфейсы libproc с runtime
 *    availability проверками: proc_pidinfo(PROC_PIDTBSDINFO),
 *    proc_listpids(PROC_PGRP_ONLY), POSIX getsid. Без SPI/private headers/
 *    entitlements, без чтения/записи auth/config, без изменения прав.
 *  - Каждый readback libproc проверяет errno и malformed byte count;
 *    насыщение буфера обрабатывается bounded retry/grow.
 *  - Zombie/reap учитываются: bounded reaping/retry, только полное пустое
 *    перечисление является GROUP_EMPTY; незавершённое/ambiguous → UNKNOWN.
 *
 * Сборка: arm64, -mmacosx-version-min=13.5. См. scripts/build-macos-run-anchor.mjs.
 */
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/sysctl.h>
#include <sys/proc.h>          /* SZOMB/SSLEEP и т.п. */
#include <sys/proc_info.h>     /* struct proc_bsdinfo, PROC_PIDTBSDINFO */
#include <libproc.h>           /* proc_pidinfo, proc_listpids */
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#include <poll.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>

#define CONTROL_FD 3

#define MAX_ARGS 512
#define MAX_ENV 128
#define MAX_STRING_BYTES (16 * 1024)
#define MAX_FRAME_BYTES (256 * 1024)
#define MAX_LINE_BYTES 4096

#define READY_TIMEOUT_MS 60000
#define GATE_WAIT_MS 120000
#define STOP_GRACE_MS 5000
#define MONITOR_INTERVAL_MS 100
#define MAX_ZOMBIE_WAIT_ITERATIONS 30
#define MAX_ENUM_FAILURE_ITERATIONS 10
#define MAX_ENUM_CAPACITY_PIDS 16384
#define MAX_ENUM_GROW_ATTEMPTS 8

#define FRAME_MAGIC 0x45424233u /* "EBB3": фрейм без ticket-секции */

#define EVIDENCE_GROUP_EMPTY "DARWIN_GROUP_EMPTY"

typedef struct {
  int pid;
  uint64_t start_sec;
  uint32_t start_usec;
} proc_start_identity;

static int control_fd = -1;

/* ---- bounded I/O ------------------------------------------------------- */

static bool write_all(int fd, const void *data, size_t size) {
  const unsigned char *p = (const unsigned char *)data;
  size_t off = 0;
  while (off < size) {
    ssize_t w = write(fd, p + off, size - off);
    if (w < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    off += (size_t)w;
  }
  return true;
}

static bool read_exact(int fd, void *data, size_t size) {
  unsigned char *p = (unsigned char *)data;
  size_t off = 0;
  while (off < size) {
    ssize_t r = read(fd, p + off, size - off);
    if (r < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    if (r == 0) return false;
    off += (size_t)r;
  }
  return true;
}

static bool read_u32(uint32_t *out) {
  unsigned char bytes[4];
  if (!read_exact(control_fd, bytes, sizeof(bytes))) return false;
  *out = ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
         ((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3];
  return true;
}

/* Читает одну LF-оконечную строку с bounded timeout; возвращает:
 *   0  успех (строка NUL-terminated в buf)
 *  -1  EOF
 *  -2  ошибка чтения
 *  -3  timeout
 *  -4  превышен лимит длины
 */
static int read_line_timeout(int fd, char *buf, size_t cap, int timeout_ms) {
  size_t n = 0;
  int remaining = timeout_ms;
  for (;;) {
    struct pollfd pfd;
    pfd.fd = fd;
    pfd.events = POLLIN;
    pfd.revents = 0;
    int pr = poll(&pfd, 1, remaining > 0 ? remaining : -1);
    if (pr < 0) {
      if (errno == EINTR) continue;
      return -2;
    }
    if (pr == 0) return -3;
    ssize_t got = read(fd, buf + n, cap - n - 1);
    if (got < 0) {
      if (errno == EINTR) continue;
      return -2;
    }
    if (got == 0) return -1;
    n += (size_t)got;
    for (size_t i = n - (size_t)got; i < n; ++i) {
      if (buf[i] == '\n') {
        buf[i] = '\0';
        return 0;
      }
    }
    if (n >= cap - 1) return -4;
  }
}

/* Неблокирующий peek control-канала: 1 = есть команда STOP, 2 = EOF, 0 = нет,
 * -1 = ошибка. Только для мониторинга после ACK. */
static int peek_control_command(const char *nonce) {
  struct pollfd pfd;
  pfd.fd = control_fd;
  pfd.events = POLLIN;
  pfd.revents = 0;
  int pr = poll(&pfd, 1, 0);
  if (pr < 0) return -1;
  if (pr == 0) return 0;
  char line[MAX_LINE_BYTES];
  int r = read_line_timeout(control_fd, line, sizeof(line), 500);
  if (r == -1) return 2; /* EOF → закрывает гейт и запускает self-stop */
  if (r != 0) return -1;
  size_t need = strlen("EBB_DARWIN_STOP\t") + 64 + 1;
  if (strncmp(line, "EBB_DARWIN_STOP\t", strlen("EBB_DARWIN_STOP\t")) != 0) return -1;
  if (strcmp(line + strlen("EBB_DARWIN_STOP\t"), nonce) != 0) return -1;
  (void)need;
  return 1;
}

/* ---- валидация --------------------------------------------------------- */

static bool is_lower_hex(const char *s, size_t len) {
  if (len == 0) return false;
  for (size_t i = 0; i < len; ++i) {
    char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

static bool parse_positive_i64(const char *s, int64_t *out) {
  if (s[0] == '\0' || s[0] == '-') return false;
  errno = 0;
  char *end = NULL;
  long long v = strtoll(s, &end, 10);
  if (errno != 0 || end == s || *end != '\0' || v <= 0) return false;
  *out = (int64_t)v;
  return true;
}

static bool valid_boot_uuid(const char *s) {
  size_t len = strlen(s);
  if (len != 36) return false;
  const int dash[4] = { 8, 13, 18, 23 };
  for (int i = 0; i < 4; ++i) {
    if (s[dash[i]] != '-') return false;
  }
  for (size_t i = 0; i < len; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) continue;
    char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
          (c >= 'A' && c <= 'F'))) return false;
  }
  return true;
}

static bool allowed_env_name(const char *name) {
  static const char *allowed[] = {
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR",
    "HERMES_HOME", "HERMES_PROFILE", "HERMES_CONFIG", "HERMES_MODEL",
    "HERMES_DATA_DIR_SUFFIX", "HERMES_RUNTIME_DIR",
    NULL,
  };
  if (name[0] == '\0') return false;
  if (!((name[0] >= 'A' && name[0] <= 'Z') || (name[0] >= 'a' && name[0] <= 'z') || name[0] == '_')) return false;
  for (size_t i = 1; name[i] != '\0'; ++i) {
    char c = name[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') || c == '_')) return false;
  }
  for (int i = 0; allowed[i] != NULL; ++i) {
    if (strcmp(name, allowed[i]) == 0) return true;
  }
  return false;
}

static bool is_credential_env_key(const char *name) {
  /* Отражает TS isCredentialEnvironmentKey: отклоняем секретные имена. */
  return strstr(name, "TOKEN") != NULL || strstr(name, "SECRET") != NULL ||
         strstr(name, "PASSWORD") != NULL || strstr(name, "CREDENTIAL") != NULL ||
         strstr(name, "API_KEY") != NULL;
}

/* ---- libproc: runtime availability + чтение identity -------------------- */

static bool libproc_runtime_available(void) {
  errno = 0;
  int est = proc_listpids(PROC_PGRP_ONLY, getpgrp(), NULL, 0);
  if (est <= 0) return false;
  struct proc_bsdinfo tmp;
  errno = 0;
  int r = proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &tmp, sizeof(tmp));
  if (r != (int)sizeof(tmp)) return false;
  return true;
}

static bool query_start_identity(int pid, proc_start_identity *out) {
  struct proc_bsdinfo info;
  int r = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (r != (int)sizeof(info)) return false;
  if (info.pbi_pid != (uint32_t)pid) return false;
  out->pid = pid;
  out->start_sec = (uint64_t)info.pbi_start_tvsec;
  out->start_usec = (uint32_t)info.pbi_start_tvusec;
  return true;
}

typedef enum {
  ENUM_OK,
  ENUM_EMPTY,
  ENUM_ERROR,
  ENUM_SATURATED,
} enum_result;

/* Перечисляет группу pgid. Возвращает ENUM_EMPTY только при успешном
 * errno-zero перечислении с нулём элементов; ошибка/насыщение — отдельно. */
static enum_result list_group(int pgid, pid_t **pids_out, int *count_out) {
  int capacity = 64;
  for (int attempt = 0; attempt < MAX_ENUM_GROW_ATTEMPTS; ++attempt) {
    if (capacity > MAX_ENUM_CAPACITY_PIDS) capacity = MAX_ENUM_CAPACITY_PIDS;
    size_t bytes = (size_t)capacity * sizeof(pid_t);
    pid_t *buf = (pid_t *)malloc(bytes + 1);
    if (buf == NULL) return ENUM_ERROR;
    errno = 0;
    int r = proc_listpids(PROC_PGRP_ONLY, pgid, buf, (int)bytes);
    if (r == 0) {
      free(buf);
      if (errno != 0) return ENUM_ERROR;
      *pids_out = NULL;
      *count_out = 0;
      return ENUM_EMPTY;
    }
    if (r < 0 || r % (int)sizeof(pid_t) != 0 || (size_t)r > bytes) {
      free(buf);
      return ENUM_ERROR;
    }
    if ((size_t)r == bytes) {
      /* Буфер заполнен ровно: API не имеет флага усечения → grow. */
      free(buf);
      if (capacity >= MAX_ENUM_CAPACITY_PIDS) return ENUM_SATURATED;
      capacity *= 2;
      continue;
    }
    *pids_out = buf;
    *count_out = r / (int)sizeof(pid_t);
    return ENUM_OK;
  }
  return ENUM_SATURATED;
}

/* ---- boot-session UUID -------------------------------------------------- */

static bool read_boot_session_uuid(char *out, size_t cap) {
  size_t len = cap;
  int rc = sysctlbyname("kern.bootsessionuuid", out, &len, NULL, 0);
  if (rc != 0) return false;
  if (len == 0 || len >= cap) return false;
  out[len] = '\0';
  return valid_boot_uuid(out);
}

/* ---- протокол ----------------------------------------------------------- */

static bool send_unknown(const char *code) {
  char line[MAX_LINE_BYTES];
  int n = snprintf(line, sizeof(line), "UNKNOWN\t%s\n", code);
  if (n <= 0 || (size_t)n >= sizeof(line)) return false;
  return write_all(control_fd, line, (size_t)n);
}

static bool send_ready(const char *id, const char *nonce, const char *uuid,
                       const proc_start_identity *anchor, int pgid, int sid,
                       const proc_start_identity *runner,
                       const char *executable_identity) {
  char line[MAX_LINE_BYTES];
  int n = snprintf(line, sizeof(line),
                   "EBB_DARWIN_READY\t%s\t%s\t1\t%s\t%d\t%llu\t%u\t%d\t%d\t%d\t%llu\t%u\t%s\n",
                   id, nonce, uuid,
                   anchor->pid, (unsigned long long)anchor->start_sec, anchor->start_usec,
                   pgid, sid,
                   runner->pid, (unsigned long long)runner->start_sec, runner->start_usec,
                   executable_identity);
  if (n <= 0 || (size_t)n >= sizeof(line)) return false;
  return write_all(control_fd, line, (size_t)n);
}

static int expect_ack(const char *nonce, int timeout_ms) {
  char line[MAX_LINE_BYTES];
  int r = read_line_timeout(control_fd, line, sizeof(line), timeout_ms);
  if (r != 0) return r;
  char expected[MAX_LINE_BYTES];
  int n = snprintf(expected, sizeof(expected), "EBB_DARWIN_ACK\t%s", nonce);
  if (n <= 0 || (size_t)n >= sizeof(expected)) return -2;
  if (strcmp(line, expected) != 0) return -4;
  return 0;
}

/* ---- self-stop ---------------------------------------------------------- */

static void self_stop(int pgid) {
  if (pgid <= 1) _exit(137);
  signal(SIGTERM, SIG_IGN); /* переживаем TERM, чтобы довести KILL до группы */
  kill(-pgid, SIGTERM);
  usleep((useconds_t)STOP_GRACE_MS * 1000u);
  kill(-pgid, SIGKILL); /* self-inclusive KILL */
  _exit(137);
}

/* ---- frame-декодер ------------------------------------------------------ */

typedef struct {
  char *executable;
  char *cwd;
  char **args;
  int arg_count;
  char **env;
  int env_count;
} launch_metadata;

static void free_metadata(launch_metadata *m) {
  free(m->executable);
  free(m->cwd);
  for (int i = 0; i < m->arg_count; ++i) free(m->args[i]);
  free(m->args);
  for (int i = 0; i < m->env_count; ++i) free(m->env[i]);
  free(m->env);
  memset(m, 0, sizeof(*m));
}

static bool read_string(char **out, uint32_t *remaining) {
  uint32_t size = 0;
  if (*remaining < 4) return false;
  if (!read_u32(&size)) return false;
  *remaining -= 4;
  if (size > MAX_STRING_BYTES || size > *remaining) return false;
  *remaining -= size;
  char *s = (char *)malloc((size_t)size + 1);
  if (s == NULL) return false;
  if (size > 0 && !read_exact(control_fd, s, size)) {
    free(s);
    return false;
  }
  s[size] = '\0';
  if (memchr(s, '\0', size) != NULL) {
    free(s);
    return false;
  }
  *out = s;
  return true;
}

/* Читает метаданные launch с control_fd; magic/длина и лимиты проверяются. */
static bool read_metadata(launch_metadata *m) {
  uint32_t magic = 0, frame_len = 0, arg_count = 0, env_count = 0;
  if (!read_u32(&magic) || magic != FRAME_MAGIC) return false;
  if (!read_u32(&frame_len) || frame_len < 16 || frame_len > MAX_FRAME_BYTES) return false;
  uint32_t remaining = frame_len - 8;
  if (!read_u32(&arg_count) || !read_u32(&env_count)) return false;
  if (remaining < 8) return false;
  remaining -= 8;
  if (arg_count > MAX_ARGS || env_count > MAX_ENV) return false;
  if (!read_string(&m->executable, &remaining) || !read_string(&m->cwd, &remaining)) return false;
  if (m->executable[0] == '\0' || m->cwd[0] == '\0') return false;
  m->arg_count = (int)arg_count;
  m->args = (char **)calloc(arg_count ? arg_count : 1, sizeof(char *));
  if (m->args == NULL) return false;
  for (uint32_t i = 0; i < arg_count; ++i) {
    if (!read_string(&m->args[i], &remaining)) return false;
  }
  m->env_count = (int)env_count;
  m->env = (char **)calloc(env_count ? env_count : 1, sizeof(char *));
  if (m->env == NULL) return false;
  for (uint32_t i = 0; i < env_count; ++i) {
    char *key = NULL, *value = NULL;
    if (!read_string(&key, &remaining) || !read_string(&value, &remaining)) {
      free(key);
      free(value);
      return false;
    }
    if (!allowed_env_name(key) || is_credential_env_key(key) ||
        strchr(value, '\0') != NULL || strchr(value, '\r') != NULL || strchr(value, '\n') != NULL) {
      free(key);
      free(value);
      return false;
    }
    size_t klen = strlen(key), vlen = strlen(value);
    char *pair = (char *)malloc(klen + vlen + 2);
    if (pair == NULL) {
      free(key);
      free(value);
      return false;
    }
    memcpy(pair, key, klen);
    pair[klen] = '=';
    memcpy(pair + klen + 1, value, vlen);
    pair[klen + vlen + 1] = '\0';
    free(key);
    free(value);
    m->env[i] = pair;
  }
  return remaining == 0;
}

/* ---- sha256 (streaming, bounded) --------------------------------------- */

static bool compute_file_sha256(const char *path, char digest_hex[65]) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return false;
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size <= 0 ||
      st.st_size > 128LL * 1024 * 1024) {
    close(fd);
    return false;
  }
  unsigned char buf[65536];
  ssize_t got;
  /* Чистый SHA-256 без внешних крипто-зависимостей: портируется и собирается
   * на macOS 13.5 arm64 без private frameworks. */
  struct {
    uint32_t h[8];
    uint64_t total;
    unsigned char buffer[64];
    size_t buflen;
  } ctx;
  memset(&ctx, 0, sizeof(ctx));
  /* Инициализация констант SHA-256. */
  ctx.h[0] = 0x6a09e667u; ctx.h[1] = 0xbb67ae85u;
  ctx.h[2] = 0x3c6ef372u; ctx.h[3] = 0xa54ff53au;
  ctx.h[4] = 0x510e527fu; ctx.h[5] = 0x9b05688cu;
  ctx.h[6] = 0x1f83d9abu; ctx.h[7] = 0x5be0cd19u;
  /* Streaming-хэш: простой SHA-256 поверх буфера (без libcrypto). */
  static const uint32_t k[64] = {
    0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
    0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
    0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
    0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
    0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
    0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
    0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
    0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u,
  };
  uint64_t total_bits = 0;
  size_t buflen = 0;
  unsigned char block[64];
  for (;;) {
    got = read(fd, buf, sizeof(buf));
    if (got < 0) {
      if (errno == EINTR) continue;
      close(fd);
      return false;
    }
    if (got == 0) break;
    total_bits += (uint64_t)got * 8;
    size_t off = 0;
    while (off < (size_t)got) {
      size_t need = 64 - buflen;
      size_t take = ((size_t)got - off) < need ? ((size_t)got - off) : need;
      memcpy(ctx.buffer + buflen, buf + off, take);
      buflen += take;
      off += take;
      if (buflen == 64) {
        memcpy(block, ctx.buffer, 64);
        buflen = 0;
        /* одна итерация сжатия */
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) {
          w[i] = ((uint32_t)block[i * 4] << 24) | ((uint32_t)block[i * 4 + 1] << 16) |
                 ((uint32_t)block[i * 4 + 2] << 8) | (uint32_t)block[i * 4 + 3];
        }
        for (int i = 16; i < 64; ++i) {
          uint32_t s0 = (((w[i - 15] >> 7) | (w[i - 15] << 25)) ^
                         ((w[i - 15] >> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >> 3));
          uint32_t s1 = (((w[i - 2] >> 17) | (w[i - 2] << 15)) ^
                         ((w[i - 2] >> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >> 10));
          w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = ctx.h[0], b = ctx.h[1], c = ctx.h[2], d = ctx.h[3];
        uint32_t e = ctx.h[4], f = ctx.h[5], g = ctx.h[6], h = ctx.h[7];
        for (int i = 0; i < 64; ++i) {
          uint32_t S1 = (((e >> 6) | (e << 26)) ^ ((e >> 11) | (e << 21)) ^ ((e >> 25) | (e << 7)));
          uint32_t ch = (e & f) ^ (~e & g);
          uint32_t t1 = h + S1 + ch + k[i] + w[i];
          uint32_t S0 = (((a >> 2) | (a << 30)) ^ ((a >> 13) | (a << 19)) ^ ((a >> 22) | (a << 10)));
          uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
          uint32_t t2 = S0 + maj;
          h = g; g = f; f = e; e = d + t1;
          d = c; c = b; b = a; a = t1 + t2;
        }
        ctx.h[0] += a; ctx.h[1] += b; ctx.h[2] += c; ctx.h[3] += d;
        ctx.h[4] += e; ctx.h[5] += f; ctx.h[6] += g; ctx.h[7] += h;
      }
    }
  }
  /* финальный блок с padding */
  unsigned char final_block[128];
  size_t fb_len = 0;
  memcpy(final_block, ctx.buffer, buflen);
  fb_len = buflen;
  final_block[fb_len++] = 0x80;
  while (fb_len % 64 != 56) final_block[fb_len++] = 0x00;
  uint64_t bits = total_bits;
  for (int i = 0; i < 8; ++i) final_block[fb_len++] = (unsigned char)(bits >> (56 - i * 8));
  size_t off = 0;
  while (off < fb_len) {
    memcpy(block, final_block + off, 64);
    off += 64;
    uint32_t w[64];
    for (int i = 0; i < 16; ++i) {
      w[i] = ((uint32_t)block[i * 4] << 24) | ((uint32_t)block[i * 4 + 1] << 16) |
             ((uint32_t)block[i * 4 + 2] << 8) | (uint32_t)block[i * 4 + 3];
    }
    for (int i = 16; i < 64; ++i) {
      uint32_t s0 = (((w[i - 15] >> 7) | (w[i - 15] << 25)) ^
                     ((w[i - 15] >> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >> 3));
      uint32_t s1 = (((w[i - 2] >> 17) | (w[i - 2] << 15)) ^
                     ((w[i - 2] >> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >> 10));
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = ctx.h[0], b = ctx.h[1], c = ctx.h[2], d = ctx.h[3];
    uint32_t e = ctx.h[4], f = ctx.h[5], g = ctx.h[6], h = ctx.h[7];
    for (int i = 0; i < 64; ++i) {
      uint32_t S1 = (((e >> 6) | (e << 26)) ^ ((e >> 11) | (e << 21)) ^ ((e >> 25) | (e << 7)));
      uint32_t ch = (e & f) ^ (~e & g);
      uint32_t t1 = h + S1 + ch + k[i] + w[i];
      uint32_t S0 = (((a >> 2) | (a << 30)) ^ ((a >> 13) | (a << 19)) ^ ((a >> 22) | (a << 10)));
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      h = g; g = f; f = e; e = d + t1;
      d = c; c = b; b = a; a = t1 + t2;
    }
    ctx.h[0] += a; ctx.h[1] += b; ctx.h[2] += c; ctx.h[3] += d;
    ctx.h[4] += e; ctx.h[5] += f; ctx.h[6] += g; ctx.h[7] += h;
  }
  close(fd);
  static const char hex[] = "0123456789abcdef";
  for (int i = 0; i < 8; ++i) {
    uint32_t v = ctx.h[i];
    for (int j = 0; j < 4; ++j) {
      unsigned char byte = (unsigned char)(v >> (24 - j * 8));
      digest_hex[i * 8 + j * 2] = hex[byte >> 4];
      digest_hex[i * 8 + j * 2 + 1] = hex[byte & 0x0f];
    }
  }
  digest_hex[64] = '\0';
  return true;
}

/* ---- launch ------------------------------------------------------------- */

static int cmd_launch(int argc, char **argv) {
  if (argc != 4) return 2;
  const char *id = argv[2];
  const char *nonce = argv[3];
  if (strlen(id) != 64 || !is_lower_hex(id, 64) ||
      strlen(nonce) != 64 || !is_lower_hex(nonce, 64)) return 2;

  control_fd = CONTROL_FD;
  if (fcntl(control_fd, F_GETFD) < 0) return 2;
  int flags = fcntl(control_fd, F_GETFD);
  if (flags < 0) return 2;
  fcntl(control_fd, F_SETFD, flags | FD_CLOEXEC); /* control не наследуется payload */

  if (!libproc_runtime_available()) {
    send_unknown("DARWIN_LIBPROC_UNAVAILABLE");
    return 3;
  }

  /* Живая сессия: anchor — session и group leader. */
  if (setsid() != 0) {
    if (errno != EPERM || getpgrp() != getpid() || getsid(0) != getpid()) {
      send_unknown("DARWIN_SESSION_LEADER_UNAVAILABLE");
      return 3;
    }
  }
  int pgid = getpid();
  int sid = getpid();
  if (getpgrp() != pgid || getsid(0) != sid) {
    send_unknown("DARWIN_SESSION_LEADER_UNAVAILABLE");
    return 3;
  }

  proc_start_identity anchor;
  if (!query_start_identity(getpid(), &anchor)) {
    send_unknown("DARWIN_ANCHOR_IDENTITY_UNAVAILABLE");
    return 3;
  }

  char uuid[64];
  if (!read_boot_session_uuid(uuid, sizeof(uuid))) {
    send_unknown("DARWIN_BOOT_SESSION_UNAVAILABLE");
    return 3;
  }

  launch_metadata meta;
  memset(&meta, 0, sizeof(meta));
  if (!read_metadata(&meta)) {
    send_unknown("DARWIN_METADATA_FRAME_INVALID");
    return 3;
  }

  char executable_identity[72];
  char sha[65];
  if (!compute_file_sha256(meta.executable, sha)) {
    send_unknown("DARWIN_EXECUTABLE_IDENTITY_UNAVAILABLE");
    free_metadata(&meta);
    return 3;
  }
  snprintf(executable_identity, sizeof(executable_identity), "sha256:%s", sha);

  int gate_pipe[2];
  if (pipe(gate_pipe) != 0) {
    send_unknown("DARWIN_GATE_PIPE_UNAVAILABLE");
    free_metadata(&meta);
    return 3;
  }

  pid_t child = fork();
  if (child < 0) {
    send_unknown("DARWIN_RUNNER_FORK_FAILED");
    close(gate_pipe[0]);
    close(gate_pipe[1]);
    free_metadata(&meta);
    return 3;
  }

  if (child == 0) {
    /* Ребёнок: payload. Закрываем control и write-конец гейта. */
    close(control_fd);
    close(gate_pipe[1]);
    /* Bounded ожидание гейта до exec. */
    struct pollfd pfd;
    pfd.fd = gate_pipe[0];
    pfd.events = POLLIN;
    pfd.revents = 0;
    int pr = poll(&pfd, 1, GATE_WAIT_MS);
    if (pr != 1) _exit(125);
    unsigned char gate = 0;
    ssize_t g;
    do {
      g = read(gate_pipe[0], &gate, 1);
    } while (g < 0 && errno == EINTR);
    close(gate_pipe[0]);
    if (g != 1 || gate != 1) _exit(125);

    char **child_argv = (char **)malloc((size_t)(meta.arg_count + 2) * sizeof(char *));
    char **child_envp = (char **)malloc((size_t)(meta.env_count + 1) * sizeof(char *));
    if (child_argv == NULL || child_envp == NULL) _exit(126);
    child_argv[0] = meta.executable;
    for (int i = 0; i < meta.arg_count; ++i) child_argv[i + 1] = meta.args[i];
    child_argv[meta.arg_count + 1] = NULL;
    for (int i = 0; i < meta.env_count; ++i) child_envp[i] = meta.env[i];
    child_envp[meta.env_count] = NULL;
    execve(meta.executable, child_argv, child_envp);
    _exit(126);
  }

  /* Родитель (anchor): закрываем read-конец гейта, читаем identity runner. */
  close(gate_pipe[0]);
  proc_start_identity runner;
  if (!query_start_identity(child, &runner)) {
    close(gate_pipe[1]);
    kill(child, SIGKILL);
    waitpid(child, NULL, 0);
    send_unknown("DARWIN_RUNNER_IDENTITY_UNAVAILABLE");
    free_metadata(&meta);
    return 3;
  }

  if (!send_ready(id, nonce, uuid, &anchor, pgid, sid, &runner, executable_identity)) {
    close(gate_pipe[1]);
    kill(child, SIGKILL);
    waitpid(child, NULL, 0);
    free_metadata(&meta);
    return 3;
  }

  int ack = expect_ack(nonce, READY_TIMEOUT_MS);
  if (ack != 0) {
    /* EOF/timeout/invalid ACK: гейт закрыт; self-stop. */
    close(gate_pipe[1]);
    self_stop(pgid);
  }

  /* ACK принят: разрешаем payload, закрываем write-конец гейта. */
  unsigned char gate_byte = 1;
  if (write_all(gate_pipe[1], &gate_byte, 1)) {
    /* закрываем после записи */
  }
  close(gate_pipe[1]);
  free_metadata(&meta);

  int payload_exit = 1;
  bool child_active = true;
  int zombie_wait = 0;
  int enum_fail = 0;

  for (;;) {
    if (child_active) {
      int status = 0;
      pid_t w = waitpid(child, &status, WNOHANG);
      if (w == child) {
        child_active = false;
        payload_exit = WIFEXITED(status) ? WEXITSTATUS(status) : 1;
      } else if (w < 0 && errno != EINTR) {
        child_active = false;
      }
    }

    int ctl = peek_control_command(nonce);
    if (ctl == 1 || ctl == 2 || ctl < 0) self_stop(pgid);

    pid_t *pids = NULL;
    int count = 0;
    enum_result er = list_group(pgid, &pids, &count);

    if (er == ENUM_ERROR || er == ENUM_SATURATED) {
      free(pids);
      enum_fail++;
      if (enum_fail > MAX_ENUM_FAILURE_ITERATIONS) _exit(6);
      usleep((useconds_t)MONITOR_INTERVAL_MS * 1000u);
      continue;
    }

    bool foreign = false;
    bool foreign_zombie = true;
    bool proof_broken = false;
    if (er == ENUM_EMPTY) {
      /* Мы — член своей группы; пустое перечисление при живом anchor
       * означает несогласованность → UNKNOWN. */
      free(pids);
      _exit(6);
    }
    for (int i = 0; i < count; ++i) {
      if (pids[i] == getpid()) continue;
      foreign = true;
      struct proc_bsdinfo info;
      int r = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info));
      if (r != (int)sizeof(info) || info.pbi_pid != (uint32_t)pids[i]) {
        proof_broken = true;
        break;
      }
      if (info.pbi_status != SZOMB) foreign_zombie = false;
    }
    free(pids);

    if (proof_broken) {
      enum_fail++;
      if (enum_fail > MAX_ENUM_FAILURE_ITERATIONS) _exit(6);
      usleep((useconds_t)MONITOR_INTERVAL_MS * 1000u);
      continue;
    }

    if (!foreign) {
      /* Остались только мы: scope внешне пуст → завершение с кодом payload. */
      _exit(payload_exit);
    }

    if (foreign_zombie) {
      zombie_wait++;
      if (zombie_wait > MAX_ZOMBIE_WAIT_ITERATIONS) _exit(5); /* UNKNOWN */
    } else {
      zombie_wait = 0;
      enum_fail = 0;
    }
    usleep((useconds_t)MONITOR_INTERVAL_MS * 1000u);
  }
}

/* ---- inspect ------------------------------------------------------------ */

typedef struct {
  int anchor_pid;
  int runner_pid;
  uint64_t anchor_start_sec;
  uint32_t anchor_start_usec;
  uint64_t runner_start_sec;
  uint32_t runner_start_usec;
} inspect_identity;

static bool identity_matches(const proc_start_identity *expected, int pid, uint64_t sec, uint32_t usec) {
  return expected->pid == pid && expected->start_sec == sec && expected->start_usec == usec;
}

static int cmd_inspect(int argc, char **argv) {
  if (argc != 14) return 2;
  const char *id = argv[2];
  const char *nonce = argv[3];
  const char *expected_uuid = argv[4];
  if (strlen(id) != 64 || !is_lower_hex(id, 64) ||
      strlen(nonce) != 64 || !is_lower_hex(nonce, 64) ||
      !valid_boot_uuid(expected_uuid)) return 2;

  int64_t anchor_pid = 0, anchor_sec = 0, anchor_usec = 0;
  int64_t pgid = 0, sid = 0;
  int64_t runner_pid = 0, runner_sec = 0, runner_usec = 0;
  if (!parse_positive_i64(argv[5], &anchor_pid) || !parse_positive_i64(argv[6], &anchor_sec) ||
      !parse_positive_i64(argv[7], &anchor_usec) || anchor_usec >= 1000000 ||
      !parse_positive_i64(argv[8], &pgid) || !parse_positive_i64(argv[9], &sid) ||
      !parse_positive_i64(argv[10], &runner_pid) || !parse_positive_i64(argv[11], &runner_sec) ||
      !parse_positive_i64(argv[12], &runner_usec) || runner_usec >= 1000000) return 2;
  const char *executable_identity = argv[13];
  if (strlen(executable_identity) != 71 ||
      strncmp(executable_identity, "sha256:", 7) != 0 ||
      !is_lower_hex(executable_identity + 7, 64)) return 2;

  if (pgid != anchor_pid || sid != anchor_pid) {
    printf("UNKNOWN\tDARWIN_ANCHOR_IDENTITY_MISMATCH\n");
    return 0;
  }

  if (!libproc_runtime_available()) {
    printf("UNKNOWN\tDARWIN_LIBPROC_UNAVAILABLE\n");
    return 0;
  }

  char current_uuid[64];
  if (!read_boot_session_uuid(current_uuid, sizeof(current_uuid))) {
    printf("UNKNOWN\tDARWIN_BOOT_SESSION_UNAVAILABLE\n");
    return 0;
  }
  if (strcasecmp(current_uuid, expected_uuid) != 0) {
    printf("UNKNOWN\tDARWIN_BOOT_SESSION_CHANGED\n");
    return 0;
  }

  proc_start_identity expected_anchor;
  expected_anchor.pid = (int)anchor_pid;
  expected_anchor.start_sec = (uint64_t)anchor_sec;
  expected_anchor.start_usec = (uint32_t)anchor_usec;
  proc_start_identity expected_runner;
  expected_runner.pid = (int)runner_pid;
  expected_runner.start_sec = (uint64_t)runner_sec;
  expected_runner.start_usec = (uint32_t)runner_usec;

  /* Проба anchor: если жив и совпал — подтверждаем pgid. */
  struct proc_bsdinfo anchor_info;
  bool anchor_known_dead = false;
  bool anchor_live = false;
  {
    int r = proc_pidinfo((int)anchor_pid, PROC_PIDTBSDINFO, 0, &anchor_info, sizeof(anchor_info));
    if (r == (int)sizeof(anchor_info) && anchor_info.pbi_pid == (uint32_t)anchor_pid) {
      if (identity_matches(&expected_anchor, anchor_info.pbi_pid,
                           (uint64_t)anchor_info.pbi_start_tvsec,
                           (uint32_t)anchor_info.pbi_start_tvusec)) {
        if (anchor_info.pbi_status != SZOMB) anchor_live = true;
        else anchor_known_dead = true;
      } else {
        printf("UNKNOWN\tDARWIN_ANCHOR_IDENTITY_MISMATCH\n");
        return 0;
      }
    } else if (r == 0 || (r < 0 && (errno == ESRCH || errno == EPERM))) {
      anchor_known_dead = true;
    } else {
      printf("UNKNOWN\tDARWIN_ANCHOR_IDENTITY_UNAVAILABLE\n");
      return 0;
    }
  }

  /* Перечисление группы; пустота — только при errno-zero полном перечислении. */
  pid_t *pids = NULL;
  int count = 0;
  enum_result er = list_group((int)pgid, &pids, &count);
  if (er == ENUM_ERROR) {
    printf("UNKNOWN\tDARWIN_GROUP_ENUMERATION_UNAVAILABLE\n");
    return 0;
  }
  if (er == ENUM_SATURATED) {
    printf("UNKNOWN\tDARWIN_GROUP_SATURATED\n");
    return 0;
  }
  if (er == ENUM_EMPTY) {
    /* Группа пуста. Если anchor известен как мёртвый и мы смогли полное
     * перечисление — это и есть доказательство пустой группы; иначе несогласованно. */
    if (anchor_known_dead) {
      printf("STOPPED\tDARWIN_GROUP_EMPTY\n");
    } else {
      printf("UNKNOWN\tDARWIN_GROUP_ENUMERATION_UNAVAILABLE\n");
    }
    return 0;
  }

  bool foreign_runnable = false;
  bool foreign_zombie = true;
  bool proof_broken = false;
  bool runner_match = true;

  for (int i = 0; i < count; ++i) {
    int pid = pids[i];
    if (anchor_live && pid == (int)anchor_pid) continue;
    if (anchor_known_dead && pid == (int)anchor_pid) {
      /* Мёртвый anchor в перечислении: обрабатываем как zombie-член. */
      continue;
    }
    struct proc_bsdinfo info;
    int r = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (r != (int)sizeof(info) || info.pbi_pid != (uint32_t)pid) {
      proof_broken = true;
      break;
    }
    if (pid == (int)runner_pid) {
      if (!identity_matches(&expected_runner, info.pbi_pid,
                            (uint64_t)info.pbi_start_tvsec,
                            (uint32_t)info.pbi_start_tvusec)) {
        runner_match = false;
      }
    }
    if (info.pbi_status == SZOMB) {
      foreign_zombie = foreign_zombie && true;
      continue;
    }
    foreign_runnable = true;
    foreign_zombie = false;
  }
  free(pids);

  if (proof_broken) {
    printf("UNKNOWN\tDARWIN_GROUP_MEMBER_UNAVAILABLE\n");
    return 0;
  }
  if (!runner_match) {
    printf("UNKNOWN\tDARWIN_RUNNER_IDENTITY_MISMATCH\n");
    return 0;
  }
  if (!foreign_runnable && !anchor_live && foreign_zombie) {
    /* Только zombie-члены: bounded retry на reap; если после этого группа пуста —
     * это доказательство пустой группы, иначе UNKNOWN. */
    for (int wait = 0; wait < MAX_ZOMBIE_WAIT_ITERATIONS; ++wait) {
      usleep((useconds_t)MONITOR_INTERVAL_MS * 1000u);
      pid_t *again = NULL;
      int again_count = 0;
      enum_result er2 = list_group((int)pgid, &again, &again_count);
      if (er2 == ENUM_ERROR || er2 == ENUM_SATURATED) {
        printf("UNKNOWN\tDARWIN_GROUP_ENUMERATION_UNAVAILABLE\n");
        return 0;
      }
      if (er2 == ENUM_EMPTY) {
        if (anchor_known_dead) {
          printf("STOPPED\tDARWIN_GROUP_EMPTY\n");
        } else {
          printf("UNKNOWN\tDARWIN_GROUP_ENUMERATION_UNAVAILABLE\n");
        }
        return 0;
      }
      bool any_runnable = false;
      bool any_foreign = false;
      bool all_zombie = true;
      for (int i = 0; i < again_count; ++i) {
        if (again[i] == getpid()) continue;
        any_foreign = true;
        struct proc_bsdinfo info;
        int r = proc_pidinfo(again[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info));
        if (r != (int)sizeof(info) || info.pbi_pid != (uint32_t)again[i]) {
          free(again);
          printf("UNKNOWN\tDARWIN_GROUP_MEMBER_UNAVAILABLE\n");
          return 0;
        }
        if (info.pbi_status != SZOMB) {
          any_runnable = true;
          all_zombie = false;
        }
      }
      free(again);
      if (any_runnable) {
        /* Появился живь член: эмитируем LIVE (идентичность runner из ожидаемой). */
        printf("LIVE\t%s\t%s\t1\t%s\t%d\t%llu\t%u\t%d\t%d\t%d\t%llu\t%u\t%s\n",
               id, nonce, current_uuid, (int)anchor_pid,
               (unsigned long long)anchor_sec, (uint32_t)anchor_usec,
               (int)pgid, (int)sid, (int)runner_pid,
               (unsigned long long)runner_sec, (uint32_t)runner_usec,
               executable_identity);
        return 0;
      }
      if (!any_foreign || !all_zombie) {
        /* пусто/несогласованно */
        break;
      }
    }
    printf("UNKNOWN\tDARWIN_GROUP_ZOMBIE_PENDING\n");
    return 0;
  }

  if (!foreign_runnable && !anchor_live) {
    /* Нет runnable членов и anchor не жив: группа пуста — STOPPED. */
    printf("STOPPED\tDARWIN_GROUP_EMPTY\n");
    return 0;
  }

  /* Есть runnable член (или живой anchor): LIVE. */
  printf("LIVE\t%s\t%s\t1\t%s\t%d\t%llu\t%u\t%d\t%d\t%d\t%llu\t%u\t%s\n",
         id, nonce, current_uuid, (int)anchor_pid,
         (unsigned long long)anchor_sec, (uint32_t)anchor_usec,
         (int)pgid, (int)sid, (int)runner_pid,
         (unsigned long long)runner_sec, (uint32_t)runner_usec,
         executable_identity);
  return 0;
}

/* ---- main --------------------------------------------------------------- */

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (strcmp(argv[1], "launch") == 0) return cmd_launch(argc, argv);
  if (strcmp(argv[1], "inspect") == 0) return cmd_inspect(argc, argv);
  return 2;
}
