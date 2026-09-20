/** The transport carries framed output. Agent output cannot impersonate cleanup acknowledgements. */
export const remoteSessionSupervisor = String.raw`
import base64, ctypes, errno, fcntl, hashlib, json, os, pwd, re, select, shutil, signal, stat, subprocess, sys, threading, time

child = None
operation = None
locked = False
deadline = time.monotonic() + 30
pending = bytearray()
exit_code = 1
owns_execution_marker = False

def interrupted(*args):
    raise RuntimeError('interrupted')

for event in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
    signal.signal(event, interrupted)
signal.alarm(30)

def cancelled():
    return operation is not None and os.path.exists(os.path.join(operation, 'cancelled'))

def check():
    if time.monotonic() >= deadline: raise RuntimeError('timeout')
    if cancelled(): raise RuntimeError('cancelled')

def read_bytes(count):
    while len(pending) < count:
        check()
        ready, _, _ = select.select([0], [], [], 0.1)
        if not ready: continue
        chunk = os.read(0, min(65536, count - len(pending)))
        if not chunk: raise RuntimeError('incomplete_input')
        pending.extend(chunk)
    result = bytes(pending[:count])
    del pending[:count]
    return result

def header():
    while True:
        position = pending.find(b'\n')
        if position >= 0:
            if position >= 32 * 1024 * 1024: raise RuntimeError('invalid_manifest')
            result = bytes(pending[:position])
            del pending[:position + 1]
            return json.loads(result)
        if len(pending) >= 32 * 1024 * 1024: raise RuntimeError('invalid_manifest')
        check()
        ready, _, _ = select.select([0], [], [], 0.1)
        if not ready: continue
        chunk = os.read(0, 65536)
        if not chunk: raise RuntimeError('incomplete_input')
        pending.extend(chunk)

def emit(value):
    data = memoryview((json.dumps(value, separators=(',', ':')) + '\n').encode())
    until = time.monotonic() + 5
    while data:
        if time.monotonic() >= until: raise RuntimeError('output_disconnected')
        _, ready, _ = select.select([], [1], [], 0.1)
        if not ready: continue
        try: data = data[os.write(1, data):]
        except BlockingIOError: pass

def private_directory(path):
    missing = []
    current = path
    while not os.path.lexists(current):
        missing.append(current)
        current = os.path.dirname(current)
    for current in reversed(missing):
        try: os.mkdir(current, 0o700)
        except FileExistsError: pass
        sync_directory(os.path.dirname(current))
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('unsafe_operation_directory')

def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)

def fence():
    path = os.path.join(operation, 'cancelled')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try: os.fsync(fd)
    finally: os.close(fd)
    sync_directory(operation)

def terminate_group():
    if child is None: return
    try: os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    child.wait(timeout=5)
    until = time.monotonic() + 5
    while True:
        if sys.platform.startswith('linux'):
            try:
                while os.waitpid(-1, os.WNOHANG)[0]: pass
            except ChildProcessError: pass
            with open('/proc/self/task/' + str(os.getpid()) + '/children') as children:
                adopted = [int(pid) for pid in children.read().split()]
            for pid in adopted:
                try: os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass
            if not adopted: return
            if time.monotonic() >= until: raise RuntimeError('cleanup_failed')
            time.sleep(0.01)
            continue
        try: os.killpg(child.pid, 0)
        except ProcessLookupError: return
        if time.monotonic() >= until: raise RuntimeError('cleanup_failed')
        time.sleep(0.01)

os.set_blocking(1, False)
try:
    manifest = header()
    identifier = manifest['operationId']
    if not isinstance(identifier, str) or re.fullmatch('[a-f0-9]{32}', identifier) is None:
        raise RuntimeError('invalid_manifest')
    timeout = manifest['timeoutMs']
    if type(timeout) is not int or timeout < 1 or timeout > 86400000: raise RuntimeError('invalid_manifest')
    deadline = time.monotonic() + timeout / 1000
    signal.alarm(0)
    root = manifest.get('operationRoot') or os.path.expanduser('~/.local/state/thesidedoor/remote-operations')
    if not os.path.isabs(root): raise RuntimeError('invalid_manifest')
    root = os.path.normpath(root)
    remote_user = pwd.getpwuid(os.getuid()).pw_name
    if manifest.get('remoteUser', remote_user) != remote_user: raise RuntimeError('remote_identity_mismatch')
    private_directory(root)
    operation = os.path.join(root, identifier)
    private_directory(operation)
    sync_directory(root)
    recovery = manifest.get('recover') is True
    if recovery: fence()
    lock = os.open(os.path.join(operation, 'lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    while True:
        if time.monotonic() >= deadline: raise RuntimeError('timeout')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
            break
        except BlockingIOError: time.sleep(0.05)
    data_directory = os.path.join(operation, 'data')
    if recovery:
        exit_code = 0
    else:
        check()
        marker = os.open(os.path.join(operation, 'started'), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try: os.fsync(marker)
        finally: os.close(marker)
        sync_directory(operation)
        check()
        os.mkdir(data_directory, 0o700)
        paths = []
        for index, entry in enumerate(manifest['files']):
            check()
            size = entry['size']
            extension = entry['extension']
            expected_hash = entry['sha256']
            if not isinstance(expected_hash, str) or re.fullmatch('[a-f0-9]{64}', expected_hash) is None:
                raise RuntimeError('invalid_manifest')
            digest = hashlib.sha256()
            if type(size) is not int or size < 0 or size > 9007199254740991: raise RuntimeError('invalid_manifest')
            if not isinstance(extension, str) or re.fullmatch('[.a-zA-Z0-9]{0,20}', extension) is None:
                raise RuntimeError('invalid_manifest')
            path = os.path.join(data_directory, str(index) + extension)
            check()
            with open(path, 'xb') as destination:
                while size:
                    chunk = read_bytes(min(size, 65536))
                    destination.write(chunk)
                    digest.update(chunk)
                    size -= len(chunk)
            if digest.hexdigest() != expected_hash: raise RuntimeError('attachment_changed')
            paths.append(path)
        if pending: raise RuntimeError('unexpected_input')
        argv = []
        for argument in manifest['argv']:
            if isinstance(argument, str): argv.append(argument)
            elif isinstance(argument, dict) and type(argument.get('file')) is int and 0 <= argument['file'] < len(paths):
                argv.append(paths[argument['file']])
            else: raise RuntimeError('invalid_manifest')
        environment = {key: os.environ[key] for key in manifest['environmentKeys'] if key in os.environ}
        environment.update(manifest['environment'])
        prompt = base64.b64decode(manifest['input'], validate=True)
        if sys.platform.startswith('linux'):
            if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
                raise RuntimeError('supervision_unavailable')
        check()
        execution_marker = os.open(os.path.join(operation, 'execution-pending'), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try: os.fsync(execution_marker)
        finally: os.close(execution_marker)
        owns_execution_marker = True
        sync_directory(operation)
        check()
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True, env=environment)
        def feed():
            try:
                child.stdin.write(prompt)
                child.stdin.close()
            except BrokenPipeError: pass
        threading.Thread(target=feed, daemon=True).start()
        outputs = {child.stdout: 'stdout', child.stderr: 'stderr'}
        while outputs or child.poll() is None:
            check()
            if child.poll() is not None: terminate_group()
            ready, _, _ = select.select([0, *outputs], [], [], 0.1)
            for stream in ready:
                if stream == 0:
                    if not os.read(0, 1): raise RuntimeError('disconnected')
                    raise RuntimeError('unexpected_input')
                chunk = os.read(stream.fileno(), 16384)
                if chunk:
                    emit({'type': 'data', 'channel': outputs[stream], 'data': base64.b64encode(chunk).decode()})
                else:
                    del outputs[stream]
                    stream.close()
        exit_code = child.returncode if child.returncode >= 0 else 128 - child.returncode
except BaseException as error:
    try:
        code = str(error) if isinstance(error, RuntimeError) else 'remote_failed'
        emit({'type': 'failure', 'code': code})
    except BaseException: pass
finally:
    if locked:
        try:
            signal.alarm(15)
            fence()
            execution_marker = os.path.join(operation, 'execution-pending')
            if child is None and not owns_execution_marker and os.path.lexists(execution_marker):
                raise RuntimeError('cleanup_unconfirmed')
            terminate_group()
            if os.path.lexists(execution_marker): os.unlink(execution_marker)
            if os.path.lexists(os.path.join(operation, 'data')):
                shutil.rmtree(os.path.join(operation, 'data'))
            sync_directory(operation)
            emit({'type': 'cleaned', 'operationId': identifier, 'exitCode': exit_code,
                  'remoteUser': remote_user, 'operationRoot': root,
                  'containment': 'descendants' if sys.platform.startswith('linux') else 'process-group'})
        except BaseException:
            exit_code = 70
            try: emit({'type': 'failure', 'code': 'cleanup_failed'})
            except BaseException: pass
        finally:
            signal.alarm(0)
            os.close(lock)
sys.exit(exit_code)
`;
