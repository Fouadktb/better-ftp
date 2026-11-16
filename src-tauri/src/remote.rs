//! Protocol boundary shared by navigation and the bounded streaming transfer engine.
use crate::{ftp, model::*, ssh::SftpClient};
use std::{
    io::{self, Read, Write},
    net::TcpStream,
    path::Path,
};
use suppaftp::{FtpError, NativeTlsFtpStream};

pub(crate) enum RemoteClient {
    Ftp(NativeTlsFtpStream),
    Sftp(SftpClient),
}
pub(crate) struct RemoteStream(Box<dyn TransferIo>);
trait TransferIo: Read + Write + Send {
    fn data_socket(&self) -> Option<&TcpStream>;
    fn finish(self: Box<Self>) -> Result<(), String>;
}
impl<T: suppaftp::TlsStream + Send + 'static> TransferIo for suppaftp::TransferStream<T> {
    fn data_socket(&self) -> Option<&TcpStream> {
        Some(self.get_ref().get_ref())
    }
    fn finish(self: Box<Self>) -> Result<(), String> {
        (*self).finish().map_err(|e| e.to_string())
    }
}
impl TransferIo for ssh2::File {
    fn data_socket(&self) -> Option<&TcpStream> {
        None
    }
    fn finish(mut self: Box<Self>) -> Result<(), String> {
        self.close().map_err(|e| e.to_string())
    }
}

impl RemoteClient {
    pub fn socket(&self) -> Result<TcpStream, String> {
        match self {
            Self::Ftp(ftp) => ftp.get_ref().try_clone(),
            Self::Sftp(ssh) => ssh.socket.try_clone(),
        }
        .map_err(|e| format!("Cannot monitor connection: {e}"))
    }
    pub fn shutdown(&self) {
        if let Ok(socket) = self.socket() {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }
    pub fn healthy(&mut self) -> bool {
        match self {
            Self::Ftp(ftp) => ftp.noop().is_ok(),
            Self::Sftp(ssh) => ssh.sftp.realpath(Path::new(".")).is_ok(),
        }
    }
    pub fn initial_directory(&mut self, path: Option<&str>) -> Result<String, String> {
        match self {
            Self::Ftp(ftp) => {
                if let Some(path) = path.filter(|path| !path.is_empty()) {
                    ftp.cwd(path)
                        .map_err(|e| format!("Cannot open remote folder: {e}"))?;
                }
                ftp.pwd()
                    .map_err(|e| format!("Cannot read server folder: {e}"))
            }
            Self::Sftp(ssh) => {
                ssh.canonical_directory(path.filter(|p| !p.is_empty()).unwrap_or("."), ".")
            }
        }
    }
    pub fn list(&mut self, path: &str, cwd: &str) -> Result<LocalListing, String> {
        match self {
            Self::Ftp(ftp) => {
                ftp.cwd(path)
                    .map_err(|e| format!("Cannot open remote folder: {e}"))?;
                let path = ftp
                    .pwd()
                    .map_err(|e| format!("Cannot read server folder: {e}"))?;
                let entries = ftp::listing(ftp, &path)?;
                Ok(LocalListing { path, entries })
            }
            Self::Sftp(ssh) => ssh.list(path, cwd),
        }
    }
    pub fn size(&mut self, path: &str) -> Result<Option<u64>, String> {
        match self {
            Self::Ftp(ftp) => match ftp.size(path) {
                Ok(size) => Ok(Some(size as u64)),
                Err(FtpError::UnexpectedResponse(_)) => Ok(None),
                Err(e) => Err(format!("Cannot inspect remote file: {e}")),
            },
            Self::Sftp(ssh) => {
                let stat = ssh
                    .sftp
                    .stat(Path::new(path))
                    .map_err(|e| format!("Cannot inspect remote file: {e}"))?;
                if stat.perm.is_some() && !stat.is_file() {
                    return Err("Only regular remote files can be downloaded.".into());
                }
                Ok(stat.size)
            }
        }
    }
    pub fn open_upload(&mut self, path: &str) -> Result<RemoteStream, String> {
        match self {
            Self::Ftp(ftp) => {
                let (parent, name) = path.rsplit_once('/').ok_or("Choose an absolute remote destination.")?;
                let parent = if parent.is_empty() { "/" } else { parent };
                // FTP lacks portable exclusive create. Fail closed if listing cannot establish absence.
                if ftp::listing(ftp, parent)?.iter().any(|entry| entry.name == name) {
                    return Err("A remote entry already exists with this name. Rename the file first.".into());
                }
                ftp.put_with_stream(path).map(|stream| RemoteStream(Box::new(stream))).map_err(|e| format!("Cannot start upload: {e}"))
            }
            Self::Sftp(ssh) => ssh.sftp.open_mode(Path::new(path), ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE, 0o600, ssh2::OpenType::File)
                .map(|stream| RemoteStream(Box::new(stream))).map_err(|e| format!("Cannot exclusively create remote file; an entry may already exist or access was denied: {e}")),
        }
    }
    pub fn open_download(&mut self, path: &str) -> Result<RemoteStream, String> {
        match self {
            Self::Ftp(ftp) => ftp
                .retr_as_stream(path)
                .map(|stream| RemoteStream(Box::new(stream)))
                .map_err(|e| format!("Cannot start download: {e}")),
            Self::Sftp(ssh) => ssh
                .sftp
                .open(Path::new(path))
                .map(|stream| RemoteStream(Box::new(stream)))
                .map_err(|e| format!("Cannot start download: {e}")),
        }
    }
}

impl RemoteStream {
    pub fn data_socket(&self) -> Option<&TcpStream> {
        self.0.data_socket()
    }
    pub fn finish(self) -> Result<(), String> {
        self.0.finish()
    }
}
impl Read for RemoteStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}
impl Write for RemoteStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}
